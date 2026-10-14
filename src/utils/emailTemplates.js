const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Login details email for a newly created employee or client account
export const accountCredentialsEmail = ({ name, email, password, accountLabel }) => {
  const loginUrl = process.env.FRONTEND_URL;
  const appName = process.env.APP_NAME || "API Monitoring";

  const subject = `Your ${appName} ${accountLabel} account`;

  const text = [
    `Hi ${name},`,
    "",
    `Your ${accountLabel} account on ${appName} has been created.`,
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
    <p>Your ${escapeHtml(accountLabel)} account has been created. Use these details to log in:</p>
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
