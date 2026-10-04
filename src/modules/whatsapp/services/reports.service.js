import { Lead } from "../../leads/leads.model.js";
import { WhatsAppConversation } from "../models/whatsappConversation.model.js";
import { WhatsAppMessage } from "../models/whatsappMessage.model.js";
import { WhatsAppContact } from "../models/whatsappContact.model.js";
import { WhatsAppCampaign } from "../models/whatsappCampaign.model.js";
import { WhatsAppCampaignRecipient } from "../models/whatsappCampaignRecipient.model.js";
import { parseDateRange } from "../whatsapp.utils.js";

/** Aggregated WhatsApp metrics for a date range (defaults to the last 30 days). */
export async function getReport(query = {}) {
  const { from, to } = parseDateRange(query);
  const inRange = { $gte: from, $lte: to };

  const [
    totalConversations,
    newConversations,
    handovers,
    activeHandovers,
    messageGroups,
    leadsCreated,
    leadsConverted,
    optOuts,
    daily,
    campaigns,
  ] = await Promise.all([
    WhatsAppConversation.countDocuments({}),
    WhatsAppConversation.countDocuments({ createdAt: inRange }),
    WhatsAppConversation.countDocuments({ handoverAt: inRange }),
    WhatsAppConversation.countDocuments({ humanHandover: true }),
    WhatsAppMessage.aggregate([
      { $match: { createdAt: inRange } },
      { $group: { _id: { d: "$direction", s: "$status", o: "$origin" }, n: { $sum: 1 } } },
    ]),
    Lead.countDocuments({ source: "WhatsApp", createdAt: inRange }),
    Lead.countDocuments({ source: "WhatsApp", status: "Converted", updatedAt: inRange }),
    WhatsAppContact.countDocuments({ optOutAt: inRange, optOut: true }),
    WhatsAppMessage.aggregate([
      { $match: { createdAt: inRange } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
          inbound: { $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] } },
          outbound: { $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    WhatsAppCampaign.find({ createdAt: inRange }).sort({ createdAt: -1 }).limit(10).select("name status kind createdAt totals dryRun").lean(),
  ]);

  const m = { total: 0, inbound: 0, outbound: 0, queued: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, automation: 0, agent: 0, campaign: 0, system: 0 };
  for (const g of messageGroups) {
    m.total += g.n;
    m[g._id.d] += g.n;
    if (g._id.d === "outbound") {
      m[g._id.s] = (m[g._id.s] || 0) + g.n;
      m[g._id.o] = (m[g._id.o] || 0) + g.n;
    }
  }
  // "Sent" in reports = reached Meta and beyond (delivered/read imply sent)
  const sentTotal = m.accepted + m.sent + m.delivered + m.read;

  const recipientCounts = campaigns.length
    ? await WhatsAppCampaignRecipient.aggregate([
        { $match: { campaignId: { $in: campaigns.map((c) => c._id) } } },
        { $group: { _id: { c: "$campaignId", s: "$status" }, n: { $sum: 1 } } },
      ])
    : [];
  const perCampaign = new Map();
  for (const r of recipientCounts) {
    const k = String(r._id.c);
    if (!perCampaign.has(k)) perCampaign.set(k, {});
    perCampaign.get(k)[r._id.s] = r.n;
  }

  return {
    range: { from, to },
    conversations: { total: totalConversations, new: newConversations, handovers, activeHandovers },
    messages: { ...m, sentTotal },
    leads: { created: leadsCreated, converted: leadsConverted },
    optOuts,
    automationReplies: m.automation,
    daily: daily.map((d) => ({ date: d._id, inbound: d.inbound, outbound: d.outbound })),
    campaigns: campaigns.map((c) => {
      const k = perCampaign.get(String(c._id)) || {};
      return {
        _id: c._id,
        name: c.name,
        status: c.status,
        kind: c.kind,
        dryRun: c.dryRun,
        createdAt: c.createdAt,
        recipients: c.totals?.recipients || 0,
        sent: (k.Sent || 0) + (k.Delivered || 0) + (k.Read || 0),
        delivered: (k.Delivered || 0) + (k.Read || 0),
        read: k.Read || 0,
        failed: k.Failed || 0,
        skipped: k.Skipped || 0,
        pending: k.Pending || 0,
      };
    }),
  };
}
