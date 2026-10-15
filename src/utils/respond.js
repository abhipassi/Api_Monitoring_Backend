// A 400 reply with a message the website can show as-is
export const badRequest = (res, message) => res.status(400).json({ success: false, message });
