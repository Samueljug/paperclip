import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { companyService } from "../services/index.js";
import { buildOAuthAccountUsageReport } from "../services/oauth-account-usage.js";

export function oauthAccountUsageRoutes(db: Db) {
  const router = Router();
  const companies = companyService(db);

  router.get("/companies/:companyId/oauth-account-usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    const company = await companies.getById(companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }
    res.json(await buildOAuthAccountUsageReport());
  });

  return router;
}
