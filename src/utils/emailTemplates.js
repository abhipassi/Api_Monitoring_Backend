const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Login details email for a newly created employee or client account
export const accountCredentialsEmail = ({ name, email, password, accountLabel, invitedBy }) => {
  const loginUrl = process.env.FRONTEND_URL;
  const appName = process.env.APP_NAME || "API Monitoring";

  const subject = `Your ${appName} ${accountLabel} account`;
  const intro = invitedBy
    ? `${invitedBy} added you to their ${appName} team.`
    : `Your ${accountLabel} account on ${appName} has been created.`;

  const text = [
    `Hi ${name},`,
    "",
    intro,
    "",
    `Email: ${email}`,
    `Password: ${password}`,
    loginUrl ? `Login: ${loginUrl}` : "",
    "",
    "Please change this password after your first login and don't share it with anyone.",
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px">Welcome to ${escapeHtml(appName)}</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>${escapeHtml(intro)} Use these details to log in:</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280">Email</td>
        <td style="padding:6px 0"><strong>${escapeHtml(email)}</strong></td>
      </tr>
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280">Password</td>
        <td style="padding:6px 0"><code style="font-size:15px;background:#f3f4f6;padding:4px 8px;border-radius:4px">${escapeHtml(password)}</code></td>
      </tr>
    </table>
    ${
      loginUrl
        ? `<p><a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Log in</a></p>`
        : ""
    }
    <p style="color:#6b7280;font-size:13px">Please change this password after your first login and don't share it with anyone.</p>
  </div>`;

  return { subject, text, html };
};

// Link to set a new password after "forgot password"
export const passwordResetEmail = ({ name, resetUrl, expiresInMinutes }) => {
  const appName = process.env.APP_NAME || "API Monitoring";

  const subject = `Reset your ${appName} password`;

  const text = [
    `Hi ${name},`,
    "",
    `We received a request to reset your ${appName} password. Open this link to choose a new one:`,
    "",
    resetUrl,
    "",
    `The link expires in ${expiresInMinutes} minutes and can only be used once.`,
    "If you didn't ask for this, you can ignore this email. Your password won't change.",
  ].join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px">Reset your password</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>We received a request to reset your ${escapeHtml(appName)} password. Click below to choose a new one:</p>
    <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Reset password</a></p>
    <p style="color:#6b7280;font-size:13px">Or paste this link into your browser:<br><span style="word-break:break-all">${escapeHtml(resetUrl)}</span></p>
    <p style="color:#6b7280;font-size:13px">The link expires in ${expiresInMinutes} minutes and can only be used once. If you didn't ask for this, you can ignore this email. Your password won't change.</p>
  </div>`;

  return { subject, text, html };
};

// Security notice sent after a password is changed or reset
export const passwordChangedEmail = ({ name }) => {
  const appName = process.env.APP_NAME || "API Monitoring";

  const subject = `Your ${appName} password was changed`;

  const text = [
    `Hi ${name},`,
    "",
    `The password for your ${appName} account was just changed.`,
    "If this wasn't you, reset your password right away using \"Forgot password\" on the login page.",
  ].join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px">Password changed</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>The password for your ${escapeHtml(appName)} account was just changed.</p>
    <p style="color:#6b7280;font-size:13px">If this wasn't you, reset your password right away using "Forgot password" on the login page.</p>
  </div>`;

  return { subject, text, html };
};

const formatDuration = (ms) => {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} second${totalSeconds === 1 ? "" : "s"}`;

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes && !days) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
};

// Times are shown in UTC because the account has no timezone setting yet
const formatTime = (date) => `${new Date(date).toUTCString().replace("GMT", "UTC")}`;

const describeCause = (cause = {}) => {
  if (cause.message) return cause.message;
  if (cause.errorType) return cause.errorType;
  return "The check failed";
};

const alertRow = (label, value) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top">${label}</td>
        <td style="padding:6px 0">${value}</td>
      </tr>`;

// Sent when a monitor has failed several checks in a row
export const incidentOpenedEmail = ({ name, incident }) => {
  const appName = process.env.APP_NAME || "API Monitoring";
  const dashboardUrl = process.env.FRONTEND_URL;
  const cause = describeCause(incident.cause);

  const subject = `[DOWN] ${incident.monitorName} is not responding`;

  const text = [
    `Hi ${name},`,
    "",
    `Your monitor "${incident.monitorName}" has failed ${incident.failureCount} checks in a row.`,
    "",
    `URL: ${incident.monitorUrl}`,
    `Problem: ${cause}`,
    `Down since: ${formatTime(incident.startedAt)}`,
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : "",
    "",
    "We'll email you again when it responds normally.",
    `- ${appName}`,
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px;color:#b91c1c">${escapeHtml(incident.monitorName)} is down</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your monitor has failed ${escapeHtml(incident.failureCount)} checks in a row.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      ${alertRow("URL", escapeHtml(incident.monitorUrl))}
      ${alertRow("Problem", escapeHtml(cause))}
      ${alertRow("Down since", escapeHtml(formatTime(incident.startedAt)))}
    </table>
    ${
      dashboardUrl
        ? `<p><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Open dashboard</a></p>`
        : ""
    }
    <p style="color:#6b7280;font-size:13px">We'll email you again when it responds normally.</p>
  </div>`;

  return { subject, text, html };
};

// Sent when a monitor that was down passes a check again
export const incidentResolvedEmail = ({ name, incident }) => {
  const appName = process.env.APP_NAME || "API Monitoring";
  const dashboardUrl = process.env.FRONTEND_URL;
  const downtime = formatDuration(new Date(incident.resolvedAt) - new Date(incident.startedAt));

  const subject = `[RECOVERED] ${incident.monitorName} is back up`;

  const text = [
    `Hi ${name},`,
    "",
    `Your monitor "${incident.monitorName}" is responding normally again.`,
    "",
    `URL: ${incident.monitorUrl}`,
    `Down since: ${formatTime(incident.startedAt)}`,
    `Back up at: ${formatTime(incident.resolvedAt)}`,
    `Total downtime: ${downtime}`,
    dashboardUrl ? `Dashboard: ${dashboardUrl}` : "",
    "",
    `- ${appName}`,
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px;color:#15803d">${escapeHtml(incident.monitorName)} is back up</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>Your monitor is responding normally again.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      ${alertRow("URL", escapeHtml(incident.monitorUrl))}
      ${alertRow("Down since", escapeHtml(formatTime(incident.startedAt)))}
      ${alertRow("Back up at", escapeHtml(formatTime(incident.resolvedAt)))}
      ${alertRow("Total downtime", `<strong>${escapeHtml(downtime)}</strong>`)}
    </table>
    ${
      dashboardUrl
        ? `<p><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">Open dashboard</a></p>`
        : ""
    }
  </div>`;

  return { subject, text, html };
};

const ctaButton = (url, label) =>
  url
    ? `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px">${escapeHtml(label)}</a></p>`
    : "";

// To staff: a customer wants a different plan
export const planRequestReceivedEmail = ({ name, request, fromPlanName, toPlanName }) => {
  const appName = process.env.APP_NAME || "API Monitoring";
  const adminUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/admin/plan-requests` : "";

  const subject = `Plan request: ${request.clientName} wants ${toPlanName}`;

  const text = [
    `Hi ${name},`,
    "",
    `${request.clientName} asked to move from ${fromPlanName} to ${toPlanName}.`,
    `Requested by: ${request.requestedByName} (${request.requestedByEmail})`,
    request.note ? `Note: ${request.note}` : "",
    adminUrl ? `Review it: ${adminUrl}` : "",
    "",
    `- ${appName}`,
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px">New plan request</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <table style="border-collapse:collapse;margin:16px 0">
      ${alertRow("Customer", escapeHtml(request.clientName))}
      ${alertRow("Change", `${escapeHtml(fromPlanName)} &rarr; <strong>${escapeHtml(toPlanName)}</strong>`)}
      ${alertRow("Requested by", `${escapeHtml(request.requestedByName)} (${escapeHtml(request.requestedByEmail)})`)}
      ${request.note ? alertRow("Note", escapeHtml(request.note)) : ""}
    </table>
    ${ctaButton(adminUrl, "Review request")}
  </div>`;

  return { subject, text, html };
};

// To the customer's owners: staff decided on their plan request
export const planRequestDecidedEmail = ({ name, request, approved, fromPlanName, toPlanName }) => {
  const appName = process.env.APP_NAME || "API Monitoring";
  const billingUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/billing` : "";

  const subject = approved
    ? `Your plan was changed to ${toPlanName}`
    : `Your plan request was not approved`;

  const text = [
    `Hi ${name},`,
    "",
    approved
      ? `Your request was approved. ${request.clientName} is now on the ${toPlanName} plan.`
      : `Your request to move from ${fromPlanName} to ${toPlanName} was not approved.`,
    request.decisionNote ? `Note from our team: ${request.decisionNote}` : "",
    billingUrl ? `Billing: ${billingUrl}` : "",
    "",
    `- ${appName}`,
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px;color:${approved ? "#15803d" : "#b91c1c"}">${escapeHtml(approved ? `You're on ${toPlanName}` : "Plan request not approved")}</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>${escapeHtml(
      approved
        ? `Your request was approved. ${request.clientName} is now on the ${toPlanName} plan.`
        : `Your request to move from ${fromPlanName} to ${toPlanName} was not approved.`
    )}</p>
    ${request.decisionNote ? `<p style="color:#6b7280">Note from our team: ${escapeHtml(request.decisionNote)}</p>` : ""}
    ${ctaButton(billingUrl, "View billing")}
  </div>`;

  return { subject, text, html };
};

// To the customer's owners: staff changed the plan directly
export const planChangedEmail = ({ name, clientName, fromPlanName, toPlanName }) => {
  const appName = process.env.APP_NAME || "API Monitoring";
  const billingUrl = process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL}/billing` : "";

  const subject = `Your plan was changed to ${toPlanName}`;

  const text = [
    `Hi ${name},`,
    "",
    `The plan for ${clientName} was changed from ${fromPlanName} to ${toPlanName}.`,
    billingUrl ? `Billing: ${billingUrl}` : "",
    "",
    `- ${appName}`,
  ]
    .filter((line, i, arr) => line !== "" || arr[i - 1] !== "")
    .join("\n");

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937">
    <h2 style="margin:0 0 16px">Your plan was changed</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>The plan for ${escapeHtml(clientName)} was changed from ${escapeHtml(fromPlanName)} to <strong>${escapeHtml(toPlanName)}</strong>.</p>
    ${ctaButton(billingUrl, "View billing")}
  </div>`;

  return { subject, text, html };
};
