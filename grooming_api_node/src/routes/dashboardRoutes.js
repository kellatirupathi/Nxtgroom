import { Router } from "express";
import { requireSuperAdmin } from "../middleware/auth.js";
import { cachedDashboard, DashboardCollegeNotFound } from "../services/dashboardStats.js";
import { asyncRoute } from "../utils.js";

export const dashboardRouter = Router();

/**
 * The administrators' Dashboard. SUPER_ADMIN and ADMIN only: it counts every
 * college, and a BOA's view of their own campus is Daily Records.
 *
 * `college_id` narrows every figure to one institute; absent or "all" covers
 * the whole organisation.
 */
dashboardRouter.get(
  "/",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const raw = req.query.college_id;
    if (raw !== undefined && (typeof raw !== "string" || raw.length > 100)) {
      return res.status(422).json({ detail: "college_id must be a single institute id" });
    }
    const collegeId = raw && raw !== "all" ? raw.trim() : null;
    try {
      const dashboard = await cachedDashboard(req.app.locals.db, { collegeId });
      return res.json(dashboard);
    } catch (error) {
      if (error instanceof DashboardCollegeNotFound) {
        return res.status(404).json({ detail: "Institute not found" });
      }
      throw error;
    }
  })
);

