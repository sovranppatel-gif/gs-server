import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Staff, EMPLOYMENT_TYPES, WORK_MODES, STAFF_STATUSES } from "./staff.model.js";
import { StaffDepartment } from "./staffDepartment.model.js";
import { StaffDesignation } from "./staffDesignation.model.js";
import { reserveNextSequence } from "../../lib/sequence.js";
import { createActivityLog } from "../activityLog/activityLog.service.js";
import { emitSectionUpdate } from "../../lib/socket.js";

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
function conflict(message) {
  const err = new Error(message);
  err.status = 409;
  return err;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForCompare(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function asObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const raw = String(value).trim();
  return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

async function nextEmployeeId() {
  const seq = await reserveNextSequence({
    key: "staff",
    readMax: async () => {
      const [result] = await Staff.aggregate([
        { $match: { employeeId: { $regex: "^GST-EMP-[0-9]+$" } } },
        { $project: { seq: { $convert: { input: { $substrCP: ["$employeeId", 8, 20] }, to: "int", onError: 0, onNull: 0 } } } },
        { $group: { _id: null, maxSeq: { $max: "$seq" } } },
      ]);
      return result?.maxSeq || 0;
    },
  });
  return `GST-EMP-${String(seq).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

/** List-view row: no salary/bank (schema-level select:false already keeps
 * them out unless a query opts in — this just documents that on purpose). */
function toRow(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  const personal = d.personalDetails || {};
  const employment = d.employmentDetails || {};
  return {
    _id: String(d._id),
    employeeId: d.employeeId,
    fullName: personal.fullName || "",
    profilePhoto: personal.profilePhoto || "",
    personalMobile: personal.personalMobile || "",
    officialEmail: personal.officialEmail || "",
    departmentName: employment.departmentName || "",
    designationName: employment.designationName || "",
    branch: employment.branch || "",
    employmentType: employment.employmentType || "",
    joiningDate: employment.joiningDate,
    status: d.status,
    createdAt: d.createdAt,
  };
}

/** Full profile entry — bank/salary included only when the caller explicitly
 * asked for them (getStaffById), matching the schema's select:false default. */
function toEntry(doc) {
  const d = doc?.toObject ? doc.toObject() : doc;
  const personal = d.personalDetails || {};
  const emergency = d.emergencyContact || {};
  const employment = d.employmentDetails || {};
  const account = d.accountDetails || {};
  const bank = d.bankDetails || null;
  const salary = d.salaryDetails || null;
  return {
    _id: String(d._id),
    employeeId: d.employeeId,
    status: d.status,
    personalDetails: personal,
    emergencyContact: emergency,
    employmentDetails: {
      ...employment,
      departmentId: employment.departmentId ? String(employment.departmentId) : "",
      designationId: employment.designationId ? String(employment.designationId) : "",
      reportingManagerId: employment.reportingManagerId ? String(employment.reportingManagerId) : "",
    },
    accountDetails: {
      loginEnabled: Boolean(account.loginEnabled),
      username: account.username || "",
      role: account.role || "Staff",
      permissions: Array.isArray(account.permissions) ? account.permissions : [],
      lastLogin: account.lastLogin || null,
    },
    // Bank/salary are the two sections Phase 24 restricts — only ever
    // present here (the single-record profile fetch), never in toRow()/the
    // list endpoint. Account number masked to its last 4 digits; the full
    // value never leaves the database.
    salaryDetails: salary,
    bankDetails: bank
      ? { ...bank, accountNumber: bank.accountNumber ? `XXXXXX${bank.accountNumber.slice(-4)}` : "" }
      : null,
    employmentHistory: Array.isArray(d.employmentHistory) ? d.employmentHistory : [],
    offboarding: d.offboarding || {},
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// List / stats / meta
// ---------------------------------------------------------------------------

const SORT_WHITELIST = {
  newest: { "employmentDetails.joiningDate": -1 },
  oldest: { "employmentDetails.joiningDate": 1 },
  nameAsc: { "personalDetails.fullName": 1 },
  nameDesc: { "personalDetails.fullName": -1 },
  employeeId: { employeeId: 1 },
};

export async function listStaff(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(params.limit) || 20));
  const skip = (page - 1) * limit;

  const archivedOnly = String(params.archived || "") === "true";
  const query = { softDelete: archivedOnly ? true : false };
  const and = [];

  if (params.status && STAFF_STATUSES.includes(params.status)) and.push({ status: params.status });
  const departmentOid = asObjectId(params.departmentId);
  if (departmentOid) and.push({ "employmentDetails.departmentId": departmentOid });
  const designationOid = asObjectId(params.designationId);
  if (designationOid) and.push({ "employmentDetails.designationId": designationOid });
  if (params.branch) and.push({ "employmentDetails.branch": params.branch });
  if (params.employmentType && EMPLOYMENT_TYPES.includes(params.employmentType)) {
    and.push({ "employmentDetails.employmentType": params.employmentType });
  }
  if (params.workMode && WORK_MODES.includes(params.workMode)) {
    and.push({ "employmentDetails.workMode": params.workMode });
  }
  if (params.joiningYear && /^\d{4}$/.test(String(params.joiningYear))) {
    const year = Number(params.joiningYear);
    and.push({
      "employmentDetails.joiningDate": {
        $gte: new Date(Date.UTC(year, 0, 1)),
        $lt: new Date(Date.UTC(year + 1, 0, 1)),
      },
    });
  }
  if (params.probation === "true") and.push({ status: "Probation" });

  const search = String(params.search || "").trim();
  if (search) {
    const rx = new RegExp(escapeRegex(search), "i");
    and.push({
      $or: [
        { employeeId: rx },
        { "personalDetails.fullName": rx },
        { "personalDetails.officialEmail": rx },
        { "personalDetails.personalMobile": rx },
      ],
    });
  }

  if (and.length) query.$and = and;

  const sort = SORT_WHITELIST[params.sort] || SORT_WHITELIST.newest;

  const [total, docs] = await Promise.all([
    Staff.countDocuments(query).maxTimeMS(8000),
    Staff.find(query).sort(sort).skip(skip).limit(limit).lean().maxTimeMS(12000),
  ]);

  return {
    rows: docs.map(toRow),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getStaffStatsOverview() {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [total, active, inactiveStatuses, newJoiners, onProbation] = await Promise.all([
    Staff.countDocuments({ softDelete: false }).maxTimeMS(8000),
    Staff.countDocuments({ softDelete: false, status: "Active" }).maxTimeMS(8000),
    Staff.countDocuments({ softDelete: false, status: { $in: ["Resigned", "Relieved"] } }).maxTimeMS(8000),
    Staff.countDocuments({
      softDelete: false,
      "employmentDetails.joiningDate": { $gte: startOfMonth },
    }).maxTimeMS(8000),
    Staff.countDocuments({ softDelete: false, status: "Probation" }).maxTimeMS(8000),
  ]);

  return {
    total,
    active,
    inactive: inactiveStatuses,
    newJoiners,
    onProbation,
    // Present/On Leave/Documents Expiring depend on the Attendance/Leave/
    // Document sub-modules, which this pass doesn't build yet (see the
    // Staff Management report) — reported as real zeros, not fabricated,
    // until those modules exist.
    presentToday: 0,
    onLeaveToday: 0,
    documentsExpiringSoon: 0,
  };
}

export async function getStaffMeta() {
  const [departments, designations] = await Promise.all([
    StaffDepartment.find({ softDelete: false, status: "Active" }).select("name code").sort({ name: 1 }).lean(),
    StaffDesignation.find({ softDelete: false, status: "Active" })
      .select("name code departmentId departmentName level")
      .sort({ name: 1 })
      .lean(),
  ]);
  return {
    departments: departments.map((d) => ({ id: String(d._id), _id: String(d._id), name: d.name, code: d.code })),
    designations: designations.map((d) => ({
      id: String(d._id),
      _id: String(d._id),
      name: d.name,
      code: d.code,
      departmentId: d.departmentId ? String(d.departmentId) : "",
      departmentName: d.departmentName,
      level: d.level,
    })),
    employmentTypes: EMPLOYMENT_TYPES,
    workModes: WORK_MODES,
    statuses: STAFF_STATUSES,
  };
}

/** Mirrors faculty.service.js's findFacultyDoc: builds the query and applies
 * any restricted-field opt-in *before* returning, since chaining .select()
 * onto the return value of an async function chains onto a Promise, not the
 * Query — that doesn't work. */
function findStaffDoc(id, { includeRestricted = false } = {}) {
  const oid = asObjectId(id);
  let query = oid
    ? Staff.findOne({ _id: oid, softDelete: false })
    : Staff.findOne({ employeeId: String(id || "").trim().toUpperCase(), softDelete: false });
  if (includeRestricted) query = query.select("+bankDetails +salaryDetails +accountDetails.passwordHash");
  return query;
}

export async function getStaffById(id) {
  const doc = await findStaffDoc(id, { includeRestricted: true });
  if (!doc) return null;
  return toEntry(doc);
}

async function assertNoDuplicateStaff({ officialEmail, username, excludeId = null }) {
  const email = normalizeForCompare(officialEmail);
  const or = [];
  if (email) or.push({ "personalDetails.officialEmail": email });
  if (username) or.push({ "accountDetails.username": username });
  if (!or.length) return;

  const query = { softDelete: false, $or: or };
  if (excludeId) query._id = { $ne: excludeId };

  const existing = await Staff.findOne(query)
    .select("personalDetails.officialEmail accountDetails.username")
    .lean();
  if (!existing) return;

  if (email && existing.personalDetails?.officialEmail === email) {
    throw conflict("A staff member with this official email already exists");
  }
  if (username && existing.accountDetails?.username === username) {
    throw conflict("This username is already taken");
  }
}

function translateDuplicateKeyError(err) {
  if (err?.code !== 11000) return err;
  const key = Object.keys(err.keyPattern || err.keyValue || {})[0] || "";
  if (key.includes("employeeId")) return conflict("This employee ID is already in use — retry to get a new one");
  if (key.includes("officialEmail")) return conflict("A staff member with this official email already exists");
  if (key.includes("username")) return conflict("This username is already taken");
  return conflict("A staff member with these details already exists");
}

async function hydrateEmploymentRefs(employmentDetails) {
  const out = { ...employmentDetails };
  if (out.departmentId) {
    const dept = await StaffDepartment.findOne({ _id: out.departmentId, softDelete: false }).select("name").lean();
    if (!dept) throw badRequest("Selected department was not found");
    out.departmentName = dept.name;
  }
  if (out.designationId) {
    const designation = await StaffDesignation.findOne({ _id: out.designationId, softDelete: false })
      .select("name departmentId")
      .lean();
    if (!designation) throw badRequest("Selected designation was not found");
    if (designation.departmentId && out.departmentId && String(designation.departmentId) !== String(out.departmentId)) {
      throw badRequest("Selected designation does not belong to the selected department");
    }
    out.designationName = designation.name;
  }
  if (out.reportingManagerId) {
    const manager = await Staff.findOne({ _id: out.reportingManagerId, softDelete: false })
      .select("personalDetails.fullName")
      .lean();
    out.reportingManagerName = manager?.personalDetails?.fullName || "";
  } else {
    out.reportingManagerName = "";
  }
  return out;
}

async function logAndBroadcast(action, doc, editor) {
  const label = `${doc.employeeId} — ${doc.personalDetails?.fullName || ""}`;
  const verbs = { create: "Created", update: "Updated", archive: "Archived", restore: "Restored", status: "Status changed for" };
  const message = `${verbs[action] || "Updated"} staff ${label}`;

  await createActivityLog({
    section: "Staff",
    action: action === "archive" ? "delete" : action,
    actor: editor || "master-admin",
    resourceId: String(doc._id),
    message,
    path: "/api/staff",
  });
  emitSectionUpdate({ section: "Staff", action, resourceId: String(doc._id), message, at: new Date().toISOString() });
}

export async function createStaff(payload, editor = "master-admin") {
  await assertNoDuplicateStaff({
    officialEmail: payload.personalDetails.officialEmail,
    username: payload.accountDetails.loginEnabled ? payload.accountDetails.username : "",
  });

  const employmentDetails = await hydrateEmploymentRefs(payload.employmentDetails);
  const passwordHash = payload.password ? await bcrypt.hash(payload.password, 10) : "";
  const employeeId = await nextEmployeeId();

  try {
    const doc = await Staff.create({
      employeeId,
      personalDetails: payload.personalDetails,
      emergencyContact: payload.emergencyContact,
      employmentDetails,
      accountDetails: {
        loginEnabled: payload.accountDetails.loginEnabled,
        username: payload.accountDetails.loginEnabled ? payload.accountDetails.username : "",
        passwordHash,
        role: payload.accountDetails.role,
        permissions: payload.accountDetails.permissions,
      },
      salaryDetails: payload.salaryDetails,
      bankDetails: payload.bankDetails,
      status: payload.status,
      employmentHistory: [
        {
          type: "Joining",
          description: `Joined as ${employmentDetails.designationName || "staff"}${employmentDetails.departmentName ? ` in ${employmentDetails.departmentName}` : ""}`,
          date: employmentDetails.joiningDate || new Date(),
          actor: editor,
        },
      ],
      createdBy: editor,
      updatedBy: editor,
    });
    await logAndBroadcast("create", doc, editor);
    return getStaffById(doc._id);
  } catch (err) {
    throw translateDuplicateKeyError(err);
  }
}

export async function updateStaff(id, payload, editor = "master-admin") {
  const doc = await findStaffDoc(id, { includeRestricted: true });
  if (!doc) throw notFound("Staff member not found");

  await assertNoDuplicateStaff({
    officialEmail: payload.personalDetails.officialEmail,
    username: payload.accountDetails.loginEnabled ? payload.accountDetails.username : "",
    excludeId: doc._id,
  });

  const employmentDetails = await hydrateEmploymentRefs(payload.employmentDetails);

  const events = [];
  const prevDept = doc.employmentDetails?.departmentName || "";
  const prevDesig = doc.employmentDetails?.designationName || "";
  if (employmentDetails.departmentName && employmentDetails.departmentName !== prevDept) {
    events.push({ type: "Department Transfer", description: `Transferred to ${employmentDetails.departmentName}`, actor: editor });
  }
  if (employmentDetails.designationName && employmentDetails.designationName !== prevDesig) {
    events.push({ type: "Designation Change", description: `Designation changed to ${employmentDetails.designationName}`, actor: editor });
  }

  doc.personalDetails = payload.personalDetails;
  doc.emergencyContact = payload.emergencyContact;
  doc.employmentDetails = employmentDetails;
  doc.accountDetails.loginEnabled = payload.accountDetails.loginEnabled;
  doc.accountDetails.username = payload.accountDetails.loginEnabled ? payload.accountDetails.username : "";
  doc.accountDetails.role = payload.accountDetails.role;
  doc.accountDetails.permissions = payload.accountDetails.permissions;
  if (payload.password) doc.accountDetails.passwordHash = await bcrypt.hash(payload.password, 10);
  doc.salaryDetails = payload.salaryDetails;
  // A blank incoming accountNumber means "not retyped" (the frontend only
  // ever shows the admin a masked "XXXXXX1234" and never resubmits it) —
  // preserve whatever real number is already stored rather than blanking it.
  doc.bankDetails = {
    ...payload.bankDetails,
    accountNumber: payload.bankDetails.accountNumber || doc.bankDetails?.accountNumber || "",
  };
  doc.status = payload.status;
  if (events.length) doc.employmentHistory.push(...events);
  doc.updatedBy = editor;

  try {
    await doc.save();
  } catch (err) {
    throw translateDuplicateKeyError(err);
  }

  await logAndBroadcast("update", doc, editor);
  return getStaffById(doc._id);
}

export async function updateStaffStatus(id, status, editor = "master-admin") {
  if (!STAFF_STATUSES.includes(status)) throw badRequest("Invalid status");
  const doc = await findStaffDoc(id);
  if (!doc) throw notFound("Staff member not found");

  const prevStatus = doc.status;
  doc.status = status;
  doc.updatedBy = editor;
  if (status !== prevStatus) {
    doc.employmentHistory.push({
      type: "Status Change",
      description: `Status changed from ${prevStatus} to ${status}`,
      actor: editor,
    });
  }
  await doc.save();

  await logAndBroadcast("status", doc, editor);
  return getStaffById(doc._id);
}

export async function archiveStaff(id, editor = "master-admin") {
  const doc = await findStaffDoc(id);
  if (!doc) throw notFound("Staff member not found");

  doc.status = "Archived";
  doc.softDelete = true;
  doc.accountDetails.loginEnabled = false;
  doc.updatedBy = editor;
  doc.employmentHistory.push({ type: "Status Change", description: "Archived — removed from active staff list", actor: editor });
  await doc.save();

  await logAndBroadcast("archive", doc, editor);
  // toEntry() reads bankDetails/salaryDetails off the doc directly — fine
  // here since this doc was loaded without excluding them via findStaffDoc
  // (select:false only hides fields Mongoose didn't project in a query, and
  // findStaffDoc()'s plain findOne omits the projection entirely, so
  // Mongoose still leaves them off by default; toEntry() tolerates either).
  return toEntry(doc);
}

export async function restoreStaff(id, editor = "master-admin") {
  const doc = await Staff.findOne({ _id: asObjectId(id), softDelete: true });
  if (!doc) throw notFound("Archived staff member not found");

  doc.status = "Active";
  doc.softDelete = false;
  doc.updatedBy = editor;
  doc.employmentHistory.push({ type: "Status Change", description: "Restored from archive", actor: editor });
  await doc.save();

  await logAndBroadcast("restore", doc, editor);
  return toEntry(doc);
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export async function listStaffDepartments({ search = "", status = "" } = {}) {
  const query = { softDelete: false };
  if (status) query.status = status;
  if (search) query.name = new RegExp(escapeRegex(search), "i");

  const docs = await StaffDepartment.find(query).sort({ name: 1 }).lean().maxTimeMS(8000);
  const ids = docs.map((d) => d._id);
  const counts = ids.length
    ? await Staff.aggregate([
        { $match: { softDelete: false, "employmentDetails.departmentId": { $in: ids } } },
        { $group: { _id: "$employmentDetails.departmentId", total: { $sum: 1 }, active: { $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] } } } },
      ])
    : [];
  const countMap = new Map(counts.map((c) => [String(c._id), c]));

  return docs.map((d) => ({
    _id: String(d._id),
    id: String(d._id),
    name: d.name,
    code: d.code,
    headName: d.headName,
    description: d.description,
    status: d.status,
    totalStaff: countMap.get(String(d._id))?.total || 0,
    activeStaff: countMap.get(String(d._id))?.active || 0,
    createdAt: d.createdAt,
  }));
}

async function assertNoDuplicateDepartment(name, excludeId = null) {
  const normalized = normalizeForCompare(name);
  if (!normalized) return;
  const query = { softDelete: false, normalizedName: normalized };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await StaffDepartment.findOne(query).select("_id").lean();
  if (existing) throw conflict("A department with this name already exists");
}

export async function createStaffDepartment(payload, editor = "master-admin") {
  if (!payload.name?.trim()) throw badRequest("Department name is required");
  await assertNoDuplicateDepartment(payload.name);
  try {
    const doc = await StaffDepartment.create({
      ...payload,
      normalizedName: normalizeForCompare(payload.name),
      createdBy: editor,
      updatedBy: editor,
    });
    return { _id: String(doc._id), id: String(doc._id), ...payload, status: doc.status };
  } catch (err) {
    if (err?.code === 11000) throw conflict("A department with this name already exists");
    throw err;
  }
}

export async function updateStaffDepartment(id, payload, editor = "master-admin") {
  if (!payload.name?.trim()) throw badRequest("Department name is required");
  await assertNoDuplicateDepartment(payload.name, id);
  const updated = await StaffDepartment.findOneAndUpdate(
    { _id: id, softDelete: false },
    { ...payload, normalizedName: normalizeForCompare(payload.name), updatedBy: editor },
    { new: true }
  );
  if (!updated) throw notFound("Department not found");
  return { _id: String(updated._id), id: String(updated._id), name: updated.name, code: updated.code, headName: updated.headName, description: updated.description, status: updated.status };
}

export async function setStaffDepartmentStatus(id, status, editor = "master-admin") {
  const updated = await StaffDepartment.findOneAndUpdate(
    { _id: id, softDelete: false },
    { status, updatedBy: editor },
    { new: true }
  );
  if (!updated) throw notFound("Department not found");
  return updated;
}

export async function archiveStaffDepartment(id, editor = "master-admin") {
  const activeStaffCount = await Staff.countDocuments({ softDelete: false, "employmentDetails.departmentId": id });
  if (activeStaffCount > 0) {
    throw conflict(`Cannot archive — ${activeStaffCount} staff member(s) are still assigned to this department. Reassign them first.`);
  }
  const updated = await StaffDepartment.findOneAndUpdate(
    { _id: id, softDelete: false },
    { softDelete: true, status: "Inactive", updatedBy: editor },
    { new: true }
  );
  if (!updated) throw notFound("Department not found");
  return updated;
}

// ---------------------------------------------------------------------------
// Designations
// ---------------------------------------------------------------------------

export async function listStaffDesignations({ search = "", status = "", departmentId = "" } = {}) {
  const query = { softDelete: false };
  if (status) query.status = status;
  const deptOid = asObjectId(departmentId);
  if (deptOid) query.departmentId = deptOid;
  if (search) query.name = new RegExp(escapeRegex(search), "i");

  const docs = await StaffDesignation.find(query).sort({ departmentName: 1, name: 1 }).lean().maxTimeMS(8000);
  return docs.map((d) => ({
    _id: String(d._id),
    id: String(d._id),
    name: d.name,
    code: d.code,
    departmentId: d.departmentId ? String(d.departmentId) : "",
    departmentName: d.departmentName,
    description: d.description,
    level: d.level,
    status: d.status,
    createdAt: d.createdAt,
  }));
}

async function assertNoDuplicateDesignation(name, departmentId, excludeId = null) {
  const normalized = normalizeForCompare(name);
  if (!normalized) return;
  const query = { softDelete: false, normalizedName: normalized, departmentId: departmentId || null };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await StaffDesignation.findOne(query).select("_id").lean();
  if (existing) throw conflict("A designation with this name already exists in this department");
}

export async function createStaffDesignation(payload, editor = "master-admin") {
  if (!payload.name?.trim()) throw badRequest("Designation name is required");
  const departmentOid = asObjectId(payload.departmentId);
  let departmentName = "";
  if (departmentOid) {
    const dept = await StaffDepartment.findOne({ _id: departmentOid, softDelete: false }).select("name").lean();
    if (!dept) throw badRequest("Selected department was not found");
    departmentName = dept.name;
  }
  await assertNoDuplicateDesignation(payload.name, departmentOid);
  let doc;
  try {
    doc = await StaffDesignation.create({
      ...payload,
      departmentId: departmentOid,
      departmentName,
      normalizedName: normalizeForCompare(payload.name),
      createdBy: editor,
      updatedBy: editor,
    });
  } catch (err) {
    if (err?.code === 11000) throw conflict("A designation with this name already exists in this department");
    throw err;
  }
  return {
    _id: String(doc._id),
    id: String(doc._id),
    name: doc.name,
    code: doc.code,
    departmentId: departmentOid ? String(departmentOid) : "",
    departmentName,
    description: doc.description,
    level: doc.level,
    status: doc.status,
    createdAt: doc.createdAt,
  };
}

export async function updateStaffDesignation(id, payload, editor = "master-admin") {
  if (!payload.name?.trim()) throw badRequest("Designation name is required");
  const departmentOid = asObjectId(payload.departmentId);
  let departmentName = "";
  if (departmentOid) {
    const dept = await StaffDepartment.findOne({ _id: departmentOid, softDelete: false }).select("name").lean();
    if (!dept) throw badRequest("Selected department was not found");
    departmentName = dept.name;
  }
  await assertNoDuplicateDesignation(payload.name, departmentOid, id);
  const updated = await StaffDesignation.findOneAndUpdate(
    { _id: id, softDelete: false },
    { ...payload, departmentId: departmentOid, departmentName, normalizedName: normalizeForCompare(payload.name), updatedBy: editor },
    { new: true }
  );
  if (!updated) throw notFound("Designation not found");
  return updated;
}

export async function setStaffDesignationStatus(id, status, editor = "master-admin") {
  const updated = await StaffDesignation.findOneAndUpdate(
    { _id: id, softDelete: false },
    { status, updatedBy: editor },
    { new: true }
  );
  if (!updated) throw notFound("Designation not found");
  return updated;
}

export async function archiveStaffDesignation(id, editor = "master-admin") {
  const activeStaffCount = await Staff.countDocuments({ softDelete: false, "employmentDetails.designationId": id });
  if (activeStaffCount > 0) {
    throw conflict(`Cannot archive — ${activeStaffCount} staff member(s) still hold this designation. Reassign them first.`);
  }
  const updated = await StaffDesignation.findOneAndUpdate(
    { _id: id, softDelete: false },
    { softDelete: true, status: "Inactive", updatedBy: editor },
    { new: true }
  );
  if (!updated) throw notFound("Designation not found");
  return updated;
}
