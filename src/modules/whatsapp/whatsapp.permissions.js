/**
 * Action-level permissions for the General WhatsApp module.
 *
 * The project currently has a single Master Admin role (requireMasterAdminJwt)
 * and no central RBAC, so a verified master admin holds every permission.
 * If tokens later carry `permissions`, they are enforced here without
 * touching the routes.
 */
export const WA_PERMISSIONS = Object.freeze({
  VIEW: "whatsapp.view",
  SEND: "whatsapp.send",
  BULK_SEND: "whatsapp.bulk_send",
  AUTOMATION: "whatsapp.automation",
  TEMPLATES: "whatsapp.templates",
  CAMPAIGNS: "whatsapp.campaigns",
  SETTINGS: "whatsapp.settings",
});

export function permissionsFor(masterAdmin) {
  if (!masterAdmin) return [];
  if (Array.isArray(masterAdmin.permissions)) return masterAdmin.permissions;
  return Object.values(WA_PERMISSIONS);
}

export function requireWhatsappPermission(permission) {
  return (req, res, next) => {
    if (!permissionsFor(req.masterAdmin).includes(permission)) {
      return res.status(403).json({ success: false, message: `Missing permission: ${permission}` });
    }
    return next();
  };
}
