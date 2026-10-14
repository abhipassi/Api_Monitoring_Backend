import nodemailer from "nodemailer";

let transporter;
let transporterKey;

// Rebuilt whenever the SMTP settings change, so a new configuration takes effect without a restart
const getTransporter = () => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS)");
  }

  const key = [SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS].join("|");
  if (transporter && key === transporterKey) return transporter;

  const port = Number(SMTP_PORT) || 587;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  transporterKey = key;

  return transporter;
};

const sendEmail = ({ to, subject, html, text }) =>
  getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    text,
  });

export default sendEmail;
