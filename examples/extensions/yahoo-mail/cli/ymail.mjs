#!/usr/bin/env node

import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";

const IMAP_HOST = "imap.mail.yahoo.com";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.mail.yahoo.com";
const SMTP_PORT = 465;

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(JSON.stringify({ error: `${name} not set` }));
    process.exit(1);
  }
  return v;
}

async function withClient(fn) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: {
      user: env("YAHOO_EMAIL"),
      pass: env("YAHOO_APP_PASSWORD"),
    },
    logger: false,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

function formatMessage(msg) {
  return {
    uid: msg.uid,
    messageId: msg.envelope?.messageId ?? null,
    inReplyTo: msg.envelope?.inReplyTo ?? null,
    from: msg.envelope?.from?.map((a) => `${a.name || ""} <${a.address}>`).join(", ") ?? "",
    to: msg.envelope?.to?.map((a) => `${a.name || ""} <${a.address}>`).join(", ") ?? "",
    subject: msg.envelope?.subject ?? "",
    date: msg.envelope?.date?.toISOString() ?? "",
    flags: [...(msg.flags || [])],
  };
}

async function downloadTextBody(client, uid) {
  const msg = await client.fetchOne(uid, {
    uid: true,
    bodyStructure: true,
  });
  const parts = flattenParts(msg.bodyStructure);
  const textPart = parts.find((p) => p.type === "text/plain") || parts.find((p) => p.type === "text/html");
  if (!textPart) return "(no text body)";

  const { content } = await client.download(uid.toString(), textPart.part, { uid: true });
  const chunks = [];
  for await (const chunk of content) {
    chunks.push(chunk);
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (textPart.type === "text/html") {
    text = text.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  }
  return text.trim().slice(0, 10_000);
}

function flattenParts(structure, prefix = "") {
  const results = [];
  if (!structure) return results;

  if (structure.childNodes) {
    for (let i = 0; i < structure.childNodes.length; i++) {
      const partNum = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      results.push(...flattenParts(structure.childNodes[i], partNum));
    }
  } else {
    results.push({
      part: prefix || "1",
      type: structure.type,
      encoding: structure.encoding,
      size: structure.size,
    });
  }
  return results;
}

const commands = {
  async "list-folders"() {
    return withClient(async (client) => {
      const folders = await client.list();
      const result = folders.map((f) => ({
        path: f.path,
        name: f.name,
        specialUse: f.specialUse || null,
        messages: f.status?.messages ?? null,
      }));
      console.log(JSON.stringify(result));
    });
  },

  async "list-inbox"() {
    const folder = process.argv[3] || "INBOX";
    const limit = parseInt(process.argv[4] || "50", 10);
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const status = await client.status(folder, { messages: true });
        const total = status.messages || 0;
        const start = Math.max(1, total - limit + 1);
        const messages = [];
        for await (const msg of client.fetch(`${start}:*`, {
          envelope: true,
          flags: true,
        })) {
          messages.push(formatMessage(msg));
        }
        messages.reverse();
        console.log(JSON.stringify({ folder, total, messages }));
      } finally {
        lock.release();
      }
    });
  },

  async search() {
    const query = process.argv[3];
    if (!query) {
      console.error(JSON.stringify({ error: "Usage: ymail search <query> [folder] [limit]" }));
      process.exit(1);
    }
    const folder = process.argv[4] || "INBOX";
    const limit = parseInt(process.argv[5] || "20", 10);
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search(
          { or: [{ subject: query }, { from: query }, { body: query }] },
          { uid: true },
        );
        const selected = uids.slice(-limit);
        const messages = [];
        if (selected.length > 0) {
          const range = selected.join(",");
          for await (const msg of client.fetch(range, {
            envelope: true,
            flags: true,
            uid: true,
          })) {
            messages.push(formatMessage(msg));
          }
        }
        messages.reverse();
        console.log(JSON.stringify({ query, folder, total: uids.length, messages }));
      } finally {
        lock.release();
      }
    });
  },

  async read() {
    const uid = process.argv[3];
    if (!uid) {
      console.error(JSON.stringify({ error: "Usage: ymail read <uid> [folder]" }));
      process.exit(1);
    }
    const folder = process.argv[4] || "INBOX";
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(uid, {
          envelope: true,
          flags: true,
          uid: true,
        });
        const body = await downloadTextBody(client, uid);
        console.log(
          JSON.stringify({
            ...formatMessage(msg),
            body,
          })
        );
      } finally {
        lock.release();
      }
    });
  },

  async move() {
    const uid = process.argv[3];
    const destination = process.argv[4];
    if (!uid || !destination) {
      console.error(JSON.stringify({ error: "Usage: ymail move <uid> <destination-folder> [source-folder]" }));
      process.exit(1);
    }
    const source = process.argv[5] || "INBOX";
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(source);
      try {
        await client.messageMove(uid, destination, { uid: true });
        console.log(JSON.stringify({ ok: true, uid, from: source, to: destination }));
      } finally {
        lock.release();
      }
    });
  },

  async delete() {
    const uid = process.argv[3];
    if (!uid) {
      console.error(JSON.stringify({ error: "Usage: ymail delete <uid> [folder]" }));
      process.exit(1);
    }
    const folder = process.argv[4] || "INBOX";
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageDelete(uid, { uid: true });
        console.log(JSON.stringify({ ok: true, uid, folder }));
      } finally {
        lock.release();
      }
    });
  },

  async "mark-read"() {
    const uid = process.argv[3];
    if (!uid) {
      console.error(JSON.stringify({ error: "Usage: ymail mark-read <uid> [folder]" }));
      process.exit(1);
    }
    const folder = process.argv[4] || "INBOX";
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        console.log(JSON.stringify({ ok: true, uid, folder, marked: "read" }));
      } finally {
        lock.release();
      }
    });
  },

  async "mark-unread"() {
    const uid = process.argv[3];
    if (!uid) {
      console.error(JSON.stringify({ error: "Usage: ymail mark-unread <uid> [folder]" }));
      process.exit(1);
    }
    const folder = process.argv[4] || "INBOX";
    return withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
        console.log(JSON.stringify({ ok: true, uid, folder, marked: "unread" }));
      } finally {
        lock.release();
      }
    });
  },

  async send() {
    const to = process.argv[3];
    const subject = process.argv[4];
    const body = process.argv[5];
    if (!to || !subject || !body) {
      console.error(JSON.stringify({ error: "Usage: ymail send <to> <subject> <body>" }));
      process.exit(1);
    }
    const from = env("YAHOO_EMAIL");
    const transport = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: true,
      auth: { user: from, pass: env("YAHOO_APP_PASSWORD") },
    });
    const info = await transport.sendMail({ from, to, subject, text: body });
    console.log(JSON.stringify({ ok: true, messageId: info.messageId, to, subject }));
  },

  async reply() {
    const uid = process.argv[3];
    const body = process.argv[4];
    if (!uid || !body) {
      console.error(JSON.stringify({ error: "Usage: ymail reply <uid> <body> [folder]" }));
      process.exit(1);
    }
    const folder = process.argv[5] || "INBOX";
    const from = env("YAHOO_EMAIL");

    const original = await withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        return await client.fetchOne(uid, { envelope: true, uid: true });
      } finally {
        lock.release();
      }
    });

    const replyTo = original.envelope?.replyTo?.[0]?.address
      || original.envelope?.from?.[0]?.address;
    if (!replyTo) {
      console.error(JSON.stringify({ error: "Cannot determine reply address from original message" }));
      process.exit(1);
    }

    const originalSubject = original.envelope?.subject ?? "";
    const subject = originalSubject.startsWith("Re:") ? originalSubject : `Re: ${originalSubject}`;
    const messageId = original.envelope?.messageId;

    const headers = {};
    if (messageId) {
      headers["In-Reply-To"] = messageId;
      headers["References"] = messageId;
    }

    const transport = createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: true,
      auth: { user: from, pass: env("YAHOO_APP_PASSWORD") },
    });
    const info = await transport.sendMail({
      from,
      to: replyTo,
      subject,
      text: body,
      headers,
    });
    console.log(JSON.stringify({ ok: true, messageId: info.messageId, to: replyTo, subject }));
  },
};

const cmd = process.argv[2];
if (!cmd || !commands[cmd]) {
  console.error(
    JSON.stringify({
      error: `Unknown command: ${cmd}`,
      available: Object.keys(commands),
    })
  );
  process.exit(1);
}

commands[cmd]().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
