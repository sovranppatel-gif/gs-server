import {
  createWorkshopRegistration,
  getAllWorkshopRegistrations,
  getWorkshopRegistrationById,
  updateWorkshopRegistration,
  deleteWorkshopRegistration,
  getReferralSummary,
  getUniqueCourses,
  getUniqueSemesterYears,
  getUniqueReferralCodes,
  getActiveUniversitiesForDropdown,
  createReferralLink,
  updateReferralLink,
  getReferralLinkByCode,
  getAllReferralLinks,
  deleteReferralLink,
} from "./workshop.service.js";
import {
  normalizePayload,
  validateSubmission,
  VALID_COURSES,
  VALID_SEMESTER_YEARS,
  VALID_CODING_EXPERIENCE,
} from "./workshop.validation.js";

export async function submitWorkshopRegistration(req, res) {
  try {
    const payload = normalizePayload(req.body);
    const validationError = validateSubmission(payload);

    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }

    const result = await createWorkshopRegistration(payload);

    if (result.isDuplicate) {
      return res.status(200).json({
        success: true,
        message: result.message,
        isDuplicate: true,
        entry: result.entry,
      });
    }

    return res.status(201).json({
      success: true,
      message: result.message,
      entry: result.entry,
    });
  } catch (err) {
    console.error("[workshop] registration create error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to submit registration" });
  }
}

export async function listWorkshopRegistrations(req, res) {
  try {
    const filters = {
      status: req.query.status || null,
      referralCode: req.query.referralCode || null,
      universityId: req.query.universityId || null,
      course: req.query.course || null,
      semesterYear: req.query.semesterYear || null,
      search: req.query.search || null,
    };

    const registrations = await getAllWorkshopRegistrations(filters);

    return res.json({
      success: true,
      rows: registrations,
    });
  } catch (err) {
    console.error("[workshop] list error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch registrations" });
  }
}

export async function getWorkshopRegistrationDetail(req, res) {
  try {
    const { id } = req.params;
    const registration = await getWorkshopRegistrationById(id);

    if (!registration) {
      return res
        .status(404)
        .json({ success: false, message: "Registration not found" });
    }

    return res.json({ success: true, entry: registration });
  } catch (err) {
    console.error("[workshop] detail error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch registration" });
  }
}

export async function updateWorkshopRegistrationStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !["Registered", "Verified", "Approved", "Rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }

    const updated = await updateWorkshopRegistration(id, { status });

    if (!updated) {
      return res
        .status(404)
        .json({ success: false, message: "Registration not found" });
    }

    return res.json({
      success: true,
      message: "Registration updated",
      entry: updated,
    });
  } catch (err) {
    console.error("[workshop] update error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to update registration" });
  }
}

export async function deleteWorkshopRegistrationRecord(req, res) {
  try {
    const { id } = req.params;
    const deleted = await deleteWorkshopRegistration(id);

    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Registration not found" });
    }

    return res.json({ success: true, message: "Registration deleted" });
  } catch (err) {
    console.error("[workshop] delete error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete registration" });
  }
}

export async function getReferralSummaryHandler(req, res) {
  try {
    const summary = await getReferralSummary();
    return res.json({ success: true, data: summary });
  } catch (err) {
    console.error("[workshop] referral summary error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch summary" });
  }
}

export async function listActiveColleges(req, res) {
  try {
    const colleges = await getActiveUniversitiesForDropdown();
    return res.json({ success: true, rows: colleges });
  } catch (err) {
    console.error("[workshop] colleges list error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch colleges" });
  }
}

export async function createReferralLinkHandler(req, res) {
  try {
    const collegeName = req.body?.collegeName;
    const referralCode = req.body?.referralCode;
    const createdBy = req.masterAdmin?.email || "master-admin";

    const link = await createReferralLink({
      collegeName,
      referralCode,
      createdBy,
      workshopName: req.body?.workshopName,
      workshopPlace: req.body?.workshopPlace,
      workshopDate: req.body?.workshopDate,
      workshopStartDate: req.body?.workshopStartDate,
      workshopEndDate: req.body?.workshopEndDate,
      startTime: req.body?.startTime,
      endTime: req.body?.endTime,
    });
    return res.status(201).json({ success: true, entry: link });
  } catch (err) {
    if (err.code === "VALIDATION") {
      return res.status(400).json({ success: false, message: err.message });
    }
    if (err.code === "DUPLICATE") {
      return res.status(409).json({ success: false, message: err.message });
    }
    console.error("[workshop] referral link create error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to create referral link" });
  }
}

export async function updateReferralLinkHandler(req, res) {
  try {
    const link = await updateReferralLink(req.params.linkId, req.body || {});
    if (!link) return res.status(404).json({ success: false, message: "Referral link not found" });
    return res.json({ success: true, entry: link });
  } catch (err) {
    if (err.code === "VALIDATION") return res.status(400).json({ success: false, message: err.message });
    console.error("[workshop] referral link update error:", err);
    return res.status(500).json({ success: false, message: "Failed to update referral link" });
  }
}

export async function getReferralLinkByCodeHandler(req, res) {
  try {
    const link = await getReferralLinkByCode(req.params.referralCode);
    if (!link) return res.status(404).json({ success: false, message: "Referral link not found" });
    return res.json({ success: true, entry: link });
  } catch (err) {
    console.error("[workshop] referral link lookup error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch referral link" });
  }
}

export async function listReferralLinksHandler(req, res) {
  try {
    const links = await getAllReferralLinks();
    return res.json({ success: true, rows: links });
  } catch (err) {
    console.error("[workshop] referral link list error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch referral links" });
  }
}

export async function deleteReferralLinkHandler(req, res) {
  try {
    const { linkId } = req.params;
    const deleted = await deleteReferralLink(linkId);

    if (!deleted) {
      return res
        .status(404)
        .json({ success: false, message: "Referral link not found" });
    }

    return res.json({ success: true, message: "Referral link deleted" });
  } catch (err) {
    console.error("[workshop] referral link delete error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to delete referral link" });
  }
}

export async function getWorkshopMetadata(req, res) {
  try {
    const courses = await getUniqueCourses();
    const semesterYears = await getUniqueSemesterYears();
    const referralCodes = await getUniqueReferralCodes();

    return res.json({
      success: true,
      data: {
        courses,
        semesterYears,
        referralCodes,
        validCourses: VALID_COURSES,
        validSemesterYears: VALID_SEMESTER_YEARS,
        validCodingExperience: VALID_CODING_EXPERIENCE,
      },
    });
  } catch (err) {
    console.error("[workshop] metadata error:", err);
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch metadata" });
  }
}
