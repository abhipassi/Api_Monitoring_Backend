import net from "net";

const decodeQuotedPrintable = (s) =>
  s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

// A tiny SMTP server that records every message instead of delivering it, so tests can read the
// emails the app sends. stop() / start() simulate a mail outage on the same port.
export const createSmtpSink = () => {
  const mails = [];
  let port = 0;
  let server;
  const sockets = new Set();

  const handle = (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    sock.write("220 sink ESMTP\r\n");

    let buffer = "";
    let inData = false;
    let loginStep = 0;
    let current = { to: [], raw: "" };

    sock.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            mails.push({ to: current.to, raw: decodeQuotedPrintable(current.raw) });
            current = { to: [], raw: "" };
            sock.write("250 OK queued\r\n");
          } else {
            current.raw += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          }
          continue;
        }
        if (loginStep === 1) { loginStep = 2; sock.write("334 UGFzc3dvcmQ6\r\n"); continue; }
        if (loginStep === 2) { loginStep = 0; sock.write("235 ok\r\n"); continue; }

        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) sock.write("250-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("AUTH PLAIN")) sock.write("235 ok\r\n");
        else if (cmd.startsWith("AUTH LOGIN")) { loginStep = 1; sock.write("334 VXNlcm5hbWU6\r\n"); }
        else if (cmd.startsWith("RCPT TO")) { current.to.push(line.match(/<(.*)>/)[1].toLowerCase()); sock.write("250 OK\r\n"); }
        else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
        else sock.write("250 OK\r\n");
      }
    });
  };

  const start = () =>
    new Promise((resolve) => {
      server = net.createServer(handle);
      server.listen(port, "127.0.0.1", () => {
        port = server.address().port;
        resolve();
      });
    });

  const stop = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });

  return {
    mails,
    start,
    stop,
    get port() { return port; },
    env: () => ({
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(port),
      SMTP_USER: "alerts@test",
      SMTP_PASS: "x",
      MAIL_FROM: "Alerts <alerts@test>",
    }),
    subject: (mail) => (mail.raw.match(/^Subject: (.*)$/m) || [])[1],
    // Mails sent to one address, newest last
    to: (address) => mails.filter((m) => m.to.includes(address.toLowerCase())),
    // The password in a "your account" email
    passwordIn: (mail) => (mail.raw.match(/^Password: (\S+)/m) || [])[1],
    clear: () => { mails.length = 0; },
  };
};
