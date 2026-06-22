import type { OAuthAccountUsageResponse } from "@paperclipai/shared";
import { api } from "./client";

export const oauthAccountUsageApi = {
  get: (companyId: string) =>
    api.get<OAuthAccountUsageResponse>(`/companies/${companyId}/oauth-account-usage`),
};
