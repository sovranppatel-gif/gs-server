import { ActivityLog } from "./activityLog.model.js";
import { emitActivityLog, emitSectionUpdate } from "../../lib/socket.js";

export async function createActivityLog(payload) {
  const doc = await ActivityLog.create(payload);
  const log = doc.toObject();

  emitActivityLog(log);
  emitSectionUpdate({
    section: log.section,
    action: log.action,
    resourceId: log.resourceId || null,
    message: log.message,
    at: log.createdAt,
    logId: String(log._id),
  });

  return log;
}

export async function listActivityLogs({
  section = "",
  action = "",
  resourceId = "",
  search = "",
  page = 1,
  limit = 50,
} = {}) {
  const query = {};

  if (section) query.section = section;
  if (action) query.action = action;
  // Exact match, not a regex — resourceId is always an ObjectId string, so
  // this is the one filter safe to leave un-escaped even though `search`
  // below builds regexes from user input.
  if (resourceId) query.resourceId = resourceId;
  if (search) {
    query.$or = [
      { message: { $regex: search, $options: "i" } },
      { actor: { $regex: search, $options: "i" } },
      { section: { $regex: search, $options: "i" } },
      { action: { $regex: search, $options: "i" } },
      { path: { $regex: search, $options: "i" } },
      { resourceId: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (page - 1) * limit;
  const [rows, total, sectionAgg, actionAgg] = await Promise.all([
    ActivityLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ActivityLog.countDocuments(query),
    ActivityLog.aggregate([{ $group: { _id: "$section", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ActivityLog.aggregate([{ $group: { _id: "$action", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
  ]);

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = await ActivityLog.countDocuments({ createdAt: { $gte: startOfDay } });

  return {
    rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    stats: {
      total,
      today: todayCount,
      sections: sectionAgg.length,
      uniqueActions: actionAgg.length,
    },
    filters: {
      sections: sectionAgg.map((s) => s._id).filter(Boolean),
      actions: actionAgg.map((a) => a._id).filter(Boolean),
    },
  };
}
