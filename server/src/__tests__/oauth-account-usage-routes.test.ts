import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { oauthAccountUsageRoutes } from "../routes/oauth-account-usage.js";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockBuildReport = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  companyService: () => mockCompanyService,
}));

vi.mock("../services/oauth-account-usage.js", () => ({
  buildOAuthAccountUsageReport: mockBuildReport,
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", oauthAccountUsageRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("oauth account usage routes", () => {
  beforeEach(() => {
    mockCompanyService.getById.mockReset();
    mockBuildReport.mockReset();
    mockCompanyService.getById.mockResolvedValue({ id: "company-1" });
    mockBuildReport.mockResolvedValue({
      checkedAt: "2026-06-13T00:00:00.000Z",
      accounts: [],
      limitations: [],
    });
  });

  it("returns the OAuth usage report for board callers with company access", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/oauth-account-usage");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      checkedAt: "2026-06-13T00:00:00.000Z",
      accounts: [],
      limitations: [],
    });
    expect(mockBuildReport).toHaveBeenCalledTimes(1);
  });

  it("rejects agent callers before reading local OAuth state", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
    })).get("/api/companies/company-1/oauth-account-usage");

    expect(res.status).toBe(403);
    expect(mockBuildReport).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown company before reading local OAuth state", async () => {
    mockCompanyService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/companies/company-1/oauth-account-usage");

    expect(res.status).toBe(404);
    expect(mockBuildReport).not.toHaveBeenCalled();
  });
});
