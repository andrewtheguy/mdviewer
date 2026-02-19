import bcrypt from "bcryptjs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";

const username = process.argv[2]?.trim() ?? "";

if (!username) {
  console.error("Usage: npm run gen_auth -- <username>");
  process.exit(1);
}

if (username.includes(":")) {
  console.error("Username must not contain ':'");
  process.exit(1);
}

class MuteableOutput extends Writable {
  public muted = false;

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) {
      stdout.write(chunk, encoding);
    }
    callback();
  }
}

const output = new MuteableOutput();
const rl = createInterface({
  input: stdin,
  output,
  terminal: true,
});

async function readPassword(prompt: string): Promise<string> {
  stdout.write(prompt);
  output.muted = true;
  try {
    const value = await rl.question("");
    stdout.write("\n");
    return value;
  } finally {
    output.muted = false;
  }
}

try {
  const password = await readPassword("Password: ");
  if (!password) {
    console.error("Password must not be empty");
    process.exit(1);
  }

  const confirm = await readPassword("Confirm password: ");
  if (password !== confirm) {
    console.error("Passwords do not match");
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const packed = Buffer.from(`${username}:${hash}`, "utf8").toString("base64");
  console.log(packed);
} finally {
  rl.close();
}
