import { HTTP_METHODS } from "../Models/Monitor.js";
import {
  MAX_INTERVAL_SECONDS,
  getBillingCurrency,
  getPlanCatalog,
  pricesAreSample,
} from "../../config/plans.js";
import { PERMISSIONS } from "../../config/permissions.js";
import { CHECK_ERROR_TYPES } from "../Services/monitorCheckService.js";
import { getBillingProvider } from "../Services/billing/index.js";
import { MIN_PASSWORD_LENGTH } from "./passwordController.js";
import {
  MAX_BODY_LENGTH,
  MAX_HEADERS,
  MAX_NAME_LENGTH,
  MAX_URL_LENGTH,
} from "../utils/validateMonitorInput.js";

// Everything the website would otherwise have to hard-code: plans, prices, allowed values, limits.
// Public, because the login and pricing screens need it before anyone is signed in. No secrets here.
export const getMeta = (req, res) =>
  res.status(200).json({
    success: true,
    message: "Meta fetched",
    meta: {
      appName: process.env.APP_NAME || "API Monitoring",
      plans: getPlanCatalog(),
      currency: getBillingCurrency(),
      pricesAreSample: pricesAreSample(),
      paymentsEnabled: getBillingProvider().enabled,
      enums: {
        httpMethods: HTTP_METHODS,
        monitorStatuses: ["ACTIVE", "PAUSED"],
        healthStatuses: ["UNKNOWN", "UP", "DOWN"],
        incidentStatuses: ["OPEN", "RESOLVED"],
        checkErrorTypes: CHECK_ERROR_TYPES,
        clientRoles: ["OWNER", "MEMBER"],
        memberStatuses: ["ACTIVE", "DISABLED"],
        clientStatuses: ["ACTIVE", "SUSPENDED"],
        planRequestStatuses: ["PENDING", "APPROVED", "REJECTED", "CANCELED"],
        employeeRoles: ["SUPER_ADMIN", "STAFF"],
        employeeStatuses: ["ACTIVE", "INACTIVE"],
        statRanges: ["24h", "7d", "30d"],
      },
      limits: {
        maxIntervalSeconds: MAX_INTERVAL_SECONDS,
        maxHeaders: MAX_HEADERS,
        maxNameLength: MAX_NAME_LENGTH,
        maxBodyLength: MAX_BODY_LENGTH,
        maxUrlLength: MAX_URL_LENGTH,
        minPasswordLength: MIN_PASSWORD_LENGTH,
      },
      permissions: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
    },
  });
