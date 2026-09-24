import { Router } from "express";
import { requireMasterAdminJwt } from "../../middleware/requireMasterAdminJwt.js";
import {
  submitWorkshopRegistration,
  listWorkshopRegistrations,
  getWorkshopRegistrationDetail,
  updateWorkshopRegistrationStatus,
  deleteWorkshopRegistrationRecord,
  getReferralSummaryHandler,
  getWorkshopMetadata,
  listActiveColleges,
  createReferralLinkHandler,
  updateReferralLinkHandler,
  getReferralLinkByCodeHandler,
  listReferralLinksHandler,
  deleteReferralLinkHandler,
} from "./workshop.controller.js";

const router = Router();

// Public: Submit registration
router.post("/", submitWorkshopRegistration);

// Public: Active colleges for the registration form's dropdown
router.get("/colleges/active", listActiveColleges);

// Public: Get metadata (courses, years, referral codes)
router.get("/metadata/all", getWorkshopMetadata);
router.get("/referral-links/:referralCode", getReferralLinkByCodeHandler);

// Admin: List registrations with filters
router.get("/", requireMasterAdminJwt, listWorkshopRegistrations);

// Admin: Get referral summary
router.get("/summary/referral", requireMasterAdminJwt, getReferralSummaryHandler);

// Admin: Create / list / delete college referral links (must stay above
// the /:id routes below so "referral-links" is never read as an :id)
router.post("/referral-links", requireMasterAdminJwt, createReferralLinkHandler);
router.get("/referral-links", requireMasterAdminJwt, listReferralLinksHandler);
router.patch("/referral-links/:linkId", requireMasterAdminJwt, updateReferralLinkHandler);
router.delete("/referral-links/:linkId", requireMasterAdminJwt, deleteReferralLinkHandler);

// Admin: Get single registration
router.get("/:id", requireMasterAdminJwt, getWorkshopRegistrationDetail);

// Admin: Update registration status
router.patch("/:id/status", requireMasterAdminJwt, updateWorkshopRegistrationStatus);

// Admin: Delete registration
router.delete("/:id", requireMasterAdminJwt, deleteWorkshopRegistrationRecord);

export default router;
