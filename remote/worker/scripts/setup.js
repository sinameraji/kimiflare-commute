#!/usr/bin/env node
/**
 * KimiFlare Commute — Interactive setup helper
 *
 * This script walks you through deploying your own instance.
 * It does NOT handle secrets for you — it prints the exact
 * `wrangler secret put` commands so you run them yourself.
 */

import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(q) {
  return new Promise((resolve) => rl.question(q, resolve));
}

function banner(text) {
  const line = "═".repeat(text.length + 4);
  console.log(`\n  ${line}\n   ${text} \n  ${line}\n`);
}

function info(text) {
  console.log(`  ℹ ${text}`);
}

function cmd(text) {
  console.log(`\n  \x1b[36m${text}\x1b[0m\n`);
}

function success(text) {
  console.log(`  \x1b[32m✔ ${text}\x1b[0m`);
}

function warn(text) {
  console.log(`  \x1b[33m⚠ ${text}\x1b[0m`);
}

function error(text) {
  console.log(`  \x1b[31m✖ ${text}\x1b[0m`);
}

async function checkPrerequisites() {
  banner("Checking prerequisites");

  // Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split(".")[0], 10);
  if (major < 20) {
    error(`Node.js ${nodeVersion} is too old. Need ≥ 20.`);
    process.exit(1);
  }
  success(`Node.js ${nodeVersion}`);

  // Wrangler
  try {
    const wranglerVersion = execSync("wrangler --version", { encoding: "utf8" }).trim();
    success(`Wrangler ${wranglerVersion}`);
  } catch {
    error("Wrangler not found. Install it: npm install -g wrangler");
    process.exit(1);
  }

  // Wrangler auth
  try {
    execSync("wrangler whoami", { stdio: "pipe" });
    success("Wrangler is authenticated with Cloudflare");
  } catch {
    warn("Wrangler is not authenticated. Run: wrangler login");
    const ok = await ask("  Have you run `wrangler login`? (y/n) ");
    if (ok.trim().toLowerCase() !== "y") {
      info("Please run `wrangler login` first, then re-run this script.");
      process.exit(0);
    }
  }
}

async function getWorkerName() {
  banner("Worker name");
  info("This is the name of your Cloudflare Worker.");
  info("It will determine your URL: https://<name>.<subdomain>.workers.dev");

  let name = (await ask("  Worker name (default: kimiflare-commute): ")).trim();
  if (!name) name = "kimiflare-commute";

  // Update wrangler.toml
  const wranglerPath = join(__dirname, "..", "wrangler.toml");
  let toml = readFileSync(wranglerPath, "utf8");
  toml = toml.replace(/^name = ".*"$/m, `name = "${name}"`);
  writeFileSync(wranglerPath, toml);
  success(`Updated wrangler.toml with name = "${name}"`);

  return name;
}

async function getGitHubOAuth() {
  banner("GitHub OAuth app");
  info("Create a GitHub OAuth app at:");
  info("https://github.com/settings/developers");
  info("");
  info("Authorization callback URL:");
  info("  https://<your-worker>.workers.dev/auth/github/callback");
  info("(You can update this after deployment if you don't know the URL yet.)");
  info("");

  const clientId = (await ask("  GitHub OAuth Client ID: ")).trim();
  const clientSecret = (await ask("  GitHub OAuth Client Secret: ")).trim();

  if (!clientId || !clientSecret) {
    error("Both Client ID and Client Secret are required.");
    process.exit(1);
  }

  return { clientId, clientSecret };
}

async function getCloudflareCreds() {
  banner("Cloudflare credentials");
  info("You need your Cloudflare Account ID and an API token.");
  info("");
  info("Account ID: found in the right sidebar of any Cloudflare dashboard page.");
  info("API Token: create one at https://dash.cloudflare.com/profile/api-tokens");
  info("  Required permission: Account → Workers AI → Read");
  info("");

  const accountId = (await ask("  Cloudflare Account ID: ")).trim();
  const apiToken = (await ask("  Cloudflare API Token: ")).trim();

  if (!accountId || !apiToken) {
    error("Both Account ID and API Token are required.");
    process.exit(1);
  }

  return { accountId, apiToken };
}

async function getAllowedUsers() {
  banner("Access control (optional)");
  info("Restrict login to specific GitHub users by their numeric user ID.");
  info("Find your ID at: https://api.github.com/users/<your-username>");
  info("Leave blank to allow any GitHub user.");
  info("");

  const ids = (await ask("  Allowed GitHub user IDs (comma-separated, or blank): ")).trim();
  return ids || null;
}

async function createKvNamespace() {
  banner("KV Namespace");
  info("Creating KV namespace for OAuth state and sessions...");

  try {
    const output = execSync("wrangler kv:namespace create OAUTH_KV", {
      encoding: "utf8",
      cwd: join(__dirname, ".."),
    });
    const match = output.match(/id = "([a-f0-9-]+)"/);
    if (match) {
      const id = match[1];
      success(`Created KV namespace: ${id}`);

      // Update wrangler.toml
      const wranglerPath = join(__dirname, "..", "wrangler.toml");
      let toml = readFileSync(wranglerPath, "utf8");
      toml = toml.replace(/^id = ".*"$/m, `id = "${id}"`);
      writeFileSync(wranglerPath, toml);
      success("Updated wrangler.toml with new KV namespace ID");
      return id;
    }
  } catch (err) {
    warn("Could not create KV namespace automatically.");
    info("Run this manually and update wrangler.toml:");
    cmd("  wrangler kv:namespace create OAUTH_KV");
  }
  return null;
}

function generateEncryptionKey() {
  return randomBytes(32).toString("base64");
}

async function setSecrets({ clientId, clientSecret, accountId, apiToken, allowedIds }) {
  banner("Setting secrets");
  info("Run these commands one by one. Wrangler will prompt you to paste each value.");
  info("");

  const secrets = [
    { name: "GITHUB_OAUTH_CLIENT_ID", value: clientId },
    { name: "GITHUB_OAUTH_CLIENT_SECRET", value: clientSecret },
    { name: "ACCOUNT_ID", value: accountId },
    { name: "CF_API_TOKEN", value: apiToken },
    { name: "ENCRYPTION_KEY", value: generateEncryptionKey() },
  ];

  if (allowedIds) {
    secrets.push({ name: "ALLOWED_GITHUB_IDS", value: allowedIds });
  }

  for (const { name, value } of secrets) {
    info(`Setting ${name}...`);
    try {
      execSync(`wrangler secret put ${name}`, {
        input: value + "\n",
        encoding: "utf8",
        cwd: join(__dirname, ".."),
        stdio: ["pipe", "inherit", "inherit"],
      });
      success(`${name} set`);
    } catch {
      error(`Failed to set ${name}. Run manually:`);
      cmd(`  wrangler secret put ${name}`);
    }
  }
}

async function deploy() {
  banner("Deploy");
  info("Running wrangler deploy...");

  try {
    execSync("wrangler deploy", {
      encoding: "utf8",
      cwd: join(__dirname, ".."),
      stdio: "inherit",
    });
    success("Deployed!");
  } catch {
    error("Deployment failed. Run manually:");
    cmd("  wrangler deploy");
    process.exit(1);
  }
}

async function main() {
  console.log(`
  ╔══════════════════════════════════════════════════════════════╗
  ║                                                              ║
  ║     KimiFlare Commute — Self-hosted Cloudflare Worker        ║
  ║                                                              ║
  ╚══════════════════════════════════════════════════════════════╝
`);

  await checkPrerequisites();
  const workerName = await getWorkerName();
  const github = await getGitHubOAuth();
  const cf = await getCloudflareCreds();
  const allowedIds = await getAllowedUsers();
  await createKvNamespace();
  await setSecrets({ ...github, ...cf, allowedIds });
  await deploy();

  banner("Done!");
  success(`Your worker is live at:`);
  console.log(`\n  https://${workerName}.workers.dev\n`);
  info("Open that URL in your browser, log in with GitHub, and pick a repo.");
  info("If you used a placeholder callback URL, update it in your GitHub OAuth app settings now.");
  console.log("");

  rl.close();
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
