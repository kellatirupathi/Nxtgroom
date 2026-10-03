import { Router } from "express";
import { requireSuperAdmin } from "../middleware/auth.js";
import {
  cachedDashboard,
  cachedInstituteStats,
  DashboardCollegeNotFound,
  DashboardRangeError,
} from "../services/dashboardStats.js";
import { escalationReport, EscalationWeekError } from "../services/escalationReport.js";
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

/**
 * The Institutes table for a chosen date range. `from` and `to` are inclusive
 * local dates; either may be empty to leave that side open, and both empty is
 * "All time". Today's table arrives with the Dashboard itself, so the page
 * calls this only for another range.
 */
dashboardRouter.get(
  "/institutes",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const { from = "", to = "" } = req.query;
    if (typeof from !== "string" || typeof to !== "string") {
      return res.status(422).json({ detail: "from and to must each be given once" });
    }
    try {
      return res.json(await cachedInstituteStats(req.app.locals.db, { from, to }));
    } catch (error) {
      if (error instanceof DashboardRangeError) return res.status(422).json({ detail: error.message });
      throw error;
    }
  })
);

/**
 * The Escalations page behind "View all" on the Dashboard: every instructor
 * escalated in a Monday-to-Sunday week, one row per failed day of the run.
 * `week` is any date in the week (YYYY-MM-DD), this week when absent;
 * `college_id` narrows it to one institute.
 */
dashboardRouter.get(
  "/escalations",
  requireSuperAdmin,
  asyncRoute(async (req, res) => {
    const { week, college_id: rawCollege } = req.query;
    if (week !== undefined && typeof week !== "string") {
      return res.status(422).json({ detail: "week must be given once" });
    }
    if (rawCollege !== undefined && (typeof rawCollege !== "string" || rawCollege.length > 100)) {
      return res.status(422).json({ detail: "college_id must be a single institute id" });
    }
    const collegeId = rawCollege && rawCollege !== "all" ? rawCollege.trim() : null;
    try {
      return res.json(await escalationReport(req.app.locals.db, { week, collegeId }));
    } catch (error) {
      if (error instanceof EscalationWeekError) return res.status(422).json({ detail: error.message });
      throw error;
    }
  })
);
