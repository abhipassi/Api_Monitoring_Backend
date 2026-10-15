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

// Emails each person in the list. One failure is logged and doesn't stop the others.
// buildEmail(person) returns { subject, html, text }.
export const sendEmailToEach = async (people, buildEmail, failureLabel) => {
  const outcomes = await Promise.allSettled(people.map((person) => sendEmail({ to: person.email, ...buildEmail(person) })));
  outcomes.forEach((outcome) => {
    if (outcome.status === "rejected") console.error(`${failureLabel}:`, outcome.reason?.message);
  });
};

export default sendEmail;
