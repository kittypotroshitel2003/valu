#!/usr/bin/env node

/**
 * Self-bootstrapping deploy script for Figma Make sites.
 *
 * First time:   node deploy.js --init
 *   → installs dependencies, adds npm scripts, asks for domain & type
 *
 * Deploy:       node deploy.js   (or npm run deploy)
 *   → SPA:    fixes paths, builds, uploads dist/, configures Caddy
 *   → Static: uploads site files from project root, configures Caddy
 *
 * Delete site:  node deploy.js --delete site.example.com
 *   → removes site files & Caddy config from server
 *
 * The designer only needs Node.js installed. Everything else is automatic.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

// ── Constants ───────────────────────────────────────────────────────────

const CONFIG_FILE = "deploy.config.json";
const DIST_DIR = "dist";
const SITES_DIR = "/srv/sites";
const CADDY_SITES_DIR = "/etc/caddy/sites";

const DEPLOY_DEPS = ["dotenv", "ssh2", "ssh2-sftp-client"];

// ── Helpers ─────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`\x1b[36m▸\x1b[0m ${msg}`);
}
function ok(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}
function err(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Bootstrap: install deps & patch package.json ────────────────────────

function ensureDeps() {
  // Create a minimal package.json if it doesn't exist (static sites)
  if (!fs.existsSync("package.json")) {
    fs.writeFileSync("package.json", JSON.stringify({ private: true }, null, 2) + "\n");
    ok("Created minimal package.json for deploy dependencies");
  }

  const missing = DEPLOY_DEPS.filter((dep) => {
    try {
      return !fs.existsSync(path.join("node_modules", dep));
    } catch {
      return true;
    }
  });

  if (missing.length > 0) {
    log(`Installing deploy dependencies: ${missing.join(", ")}...`);
    execSync(`npm install --save-dev ${missing.join(" ")}`, {
      stdio: "inherit",
    });
    ok("Dependencies installed");
  }
}

function ensureScripts() {
  const pkgPath = "package.json";
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  let changed = false;

  if (!pkg.scripts) pkg.scripts = {};

  if (!pkg.scripts.deploy) {
    pkg.scripts.deploy = "node deploy.js";
    changed = true;
  }
  if (!pkg.scripts["deploy:init"]) {
    pkg.scripts["deploy:init"] = "node deploy.js --init";
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    ok("Added deploy scripts to package.json");
  }
}

function ensureGitignore() {
  const gitignorePath = ".gitignore";
  const requiredEntries = [
    "node_modules",
    "dist",
    ".env",
    "deploy.config.json",
  ];

  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const missing = requiredEntries.filter(
    (entry) => !content.split("\n").some((line) => line.trim() === entry),
  );

  if (missing.length > 0) {
    const addition = missing.join("\n") + "\n";
    fs.appendFileSync(gitignorePath, (content.endsWith("\n") ? "" : "\n") + addition);
    ok(`Added to .gitignore: ${missing.join(", ")}`);
  }
}

function ensureEnv() {
  if (fs.existsSync(".env")) return;

  const template = `DEPLOY_HOST=YOUR_SERVER_IP
DEPLOY_PORT=22
DEPLOY_USER=deploy
DEPLOY_PASSWORD=YOUR_PASSWORD
`;
  fs.writeFileSync(".env", template);
  log("Created .env — fill in server credentials before deploying");
}

// ── Validation ──────────────────────────────────────────────────────────

function isValidDomain(domain) {
  return /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(domain);
}

// ── Config ──────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    err(`${CONFIG_FILE} not found. Run: node deploy.js --init`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
}

async function initConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    ok(`Config already exists: domain = ${existing.domain}`);
    return existing;
  }

  const domain = await prompt("Domain (e.g. shop.example.com): ");
  if (!domain || !isValidDomain(domain)) {
    err("Invalid domain. Use format: site.example.com");
    process.exit(1);
  }

  const typeAnswer = await prompt("Site type — spa or static? (default: spa): ");
  const type = typeAnswer === "static" ? "static" : "spa";

  const config = { domain, type };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
  ok(`Config saved: ${domain} (${type})`);
  return config;
}

// ── Fix Figma asset paths ───────────────────────────────────────────────

function fixFigmaAssets() {
  const srcDir = path.join(process.cwd(), "src");
  if (!fs.existsSync(srcDir)) return 0;

  const extensions = [".tsx", ".ts", ".jsx", ".js"];
  let totalFixed = 0;

  function processDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        processDir(fullPath);
      } else if (extensions.includes(path.extname(entry.name))) {
        const content = fs.readFileSync(fullPath, "utf8");
        if (content.includes("figma:asset/")) {
          const fixed = content.replace(
            /figma:asset\/([a-f0-9A-F]+\.[a-z]+)/g,
            "@/assets/$1",
          );
          fs.writeFileSync(fullPath, fixed);
          log(`Fixed: ${path.relative(process.cwd(), fullPath)}`);
          totalFixed++;
        }
      }
    }
  }

  processDir(srcDir);
  return totalFixed;
}

// ── Server credentials ──────────────────────────────────────────────────

function getServerCreds() {
  const host = process.env.DEPLOY_HOST;
  const password = process.env.DEPLOY_PASSWORD;
  if (!host || !password || host === "YOUR_SERVER_IP" || password === "YOUR_PASSWORD") {
    err("Fill in real credentials in .env file first");
    process.exit(1);
  }
  return {
    host,
    port: Number(process.env.DEPLOY_PORT || 22),
    username: process.env.DEPLOY_USER || "deploy",
    password,
  };
}

// ── SSH exec helper ─────────────────────────────────────────────────────

async function sshExec(creds, command) {
  const { Client } = await import("ssh2");
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";

    conn
      .on("ready", () => {
        conn.exec(command, (execErr, stream) => {
          if (execErr) {
            conn.end();
            return reject(execErr);
          }
          stream
            .on("close", (code) => {
              conn.end();
              if (code !== 0) {
                reject(
                  new Error(
                    `Remote command failed (code ${code}): ${stderr}`,
                  ),
                );
              } else {
                resolve(stdout);
              }
            })
            .on("data", (data) => {
              stdout += data;
            })
            .stderr.on("data", (data) => {
              stderr += data;
            });
        });
      })
      .on("error", reject)
      .connect(creds);
  });
}

// ── Collect static site files ────────────────────────────────────────────

const STATIC_IGNORE = new Set([
  ".git",
  ".env",
  "node_modules",
  "dist",
  "deploy.js",
  "deploy.config.json",
  "DEPLOY.md",
  "package.json",
  "package-lock.json",
  ".gitignore",
]);

function collectStaticFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (dir === baseDir && STATIC_IGNORE.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectStaticFiles(fullPath, baseDir));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Upload via SFTP ─────────────────────────────────────────────────────

async function uploadDist(creds, domain) {
  const SftpClient = (await import("ssh2-sftp-client")).default;
  const sftp = new SftpClient();
  const remotePath = `${SITES_DIR}/${domain}`;

  try {
    await sftp.connect(creds);

    const exists = await sftp.exists(remotePath);
    if (exists) {
      // Clean old files before uploading new build
      await sftp.rmdir(remotePath, true);
    }
    await sftp.mkdir(remotePath, true);

    await sftp.uploadDir(DIST_DIR, remotePath);
  } finally {
    await sftp.end();
  }
}

async function uploadStatic(creds, domain) {
  const SftpClient = (await import("ssh2-sftp-client")).default;
  const sftp = new SftpClient();
  const remotePath = `${SITES_DIR}/${domain}`;
  const baseDir = process.cwd();

  try {
    await sftp.connect(creds);

    const exists = await sftp.exists(remotePath);
    if (exists) {
      await sftp.rmdir(remotePath, true);
    }
    await sftp.mkdir(remotePath, true);

    const files = collectStaticFiles(baseDir);
    // Create remote directories first
    const dirs = new Set();
    for (const file of files) {
      const rel = path.relative(baseDir, path.dirname(file));
      if (rel) dirs.add(rel);
    }
    for (const dir of [...dirs].sort()) {
      const remoteDir = `${remotePath}/${dir.replace(/\\/g, "/")}`;
      await sftp.mkdir(remoteDir, true);
    }
    // Upload files
    for (const file of files) {
      const rel = path.relative(baseDir, file).replace(/\\/g, "/");
      await sftp.put(file, `${remotePath}/${rel}`);
    }
  } finally {
    await sftp.end();
  }
}

// ── Configure Caddy ─────────────────────────────────────────────────────

function buildCaddyConfig(domain, type) {
  const routing =
    type === "static"
      ? "    try_files {path} {path}/ =404"
      : "    try_files {path} /index.html";

  return `${domain} {
    root * ${SITES_DIR}/${domain}
    file_server
${routing}
    encode gzip zstd

    # Cache hashed assets (js, css, images) — immutable, long TTL
    @hashed path *.js *.css *.woff2 *.woff *.ttf
    header @hashed Cache-Control "public, max-age=31536000, immutable"

    @images path *.png *.jpg *.jpeg *.gif *.webp *.avif *.svg *.ico
    header @images Cache-Control "public, max-age=2592000"

    # HTML — always revalidate
    @html path *.html /
    header @html Cache-Control "public, max-age=0, must-revalidate"

    # Security & performance headers
    header {
        X-Content-Type-Options "nosniff"
        X-Frame-Options "SAMEORIGIN"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }
}`;
}

async function configureCaddy(creds, domain, type) {
  const configPath = `${CADDY_SITES_DIR}/${domain}`;

  const checkResult = await sshExec(
    creds,
    `test -f ${configPath} && echo exists || echo missing`,
  );

  if (checkResult.trim() === "exists") {
    log("Caddy config already exists, skipping");
    return;
  }

  const siteConfig = buildCaddyConfig(domain, type);
  const escaped = siteConfig.replace(/'/g, "'\\''");
  await sshExec(
    creds,
    `echo '${escaped}' | sudo tee ${configPath} > /dev/null && sudo systemctl reload caddy`,
  );
  ok("Caddy configured and reloaded");
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // --list: show all deployed sites
  if (args.includes("--list")) {
    await import("dotenv/config");
    const creds = getServerCreds();
    const sites = await sshExec(creds, `ls -1 ${SITES_DIR} 2>/dev/null`);
    const list = sites.trim().split("\n").filter(Boolean);
    if (list.length === 0) {
      log("No sites deployed yet");
    } else {
      console.log(`\n\x1b[1mDeployed sites (${list.length}):\x1b[0m\n`);
      for (const site of list) {
        console.log(`  https://${site}`);
      }
      console.log();
    }
    return;
  }

  // --delete <domain>: remove site from server
  if (args.includes("--delete")) {
    const domainIdx = args.indexOf("--delete") + 1;
    const domain = args[domainIdx];
    if (!domain || !isValidDomain(domain)) {
      err("Usage: node deploy.js --delete site.example.com");
      process.exit(1);
    }

    await import("dotenv/config");
    const creds = getServerCreds();

    const confirm = await prompt(`Delete ${domain} from server? (yes/no): `);
    if (confirm !== "yes") {
      log("Cancelled");
      return;
    }

    log(`Removing site files: ${SITES_DIR}/${domain}...`);
    await sshExec(creds, `sudo rm -rf ${SITES_DIR}/${domain}`);
    ok("Site files removed");

    log(`Removing Caddy config: ${CADDY_SITES_DIR}/${domain}...`);
    await sshExec(
      creds,
      `sudo rm -f ${CADDY_SITES_DIR}/${domain} && sudo systemctl reload caddy`,
    );
    ok("Caddy config removed and reloaded");

    console.log(`\n\x1b[32m\x1b[1m✓ Deleted!\x1b[0m ${domain}\n`);
    return;
  }

  // --init: full project setup
  if (args.includes("--init")) {
    console.log("\n\x1b[1mSetting up deploy...\x1b[0m\n");

    ensureDeps();
    ensureScripts();
    ensureGitignore();
    ensureEnv();
    await initConfig();

    console.log("\n\x1b[32m\x1b[1mDone!\x1b[0m");
    console.log("  1. Fill in .env with server credentials");
    console.log("  2. Run: npm run deploy\n");
    return;
  }

  // Load .env (dynamic import since it may have just been installed)
  await import("dotenv/config");

  const config = loadConfig();
  const creds = getServerCreds();
  const { domain, type = "spa" } = config;

  if (!isValidDomain(domain)) {
    err(`Invalid domain in ${CONFIG_FILE}: "${domain}"`);
    process.exit(1);
  }

  console.log(`\n\x1b[1mDeploying ${domain} (${type})\x1b[0m\n`);

  if (type === "static") {
    // Static site: upload files directly from project root
    const files = collectStaticFiles(process.cwd());
    log(`Uploading ${files.length} files...`);
    await uploadStatic(creds, domain);
    ok("Files uploaded");
  } else {
    // SPA: fix paths, build, upload dist/
    log("Checking Figma asset paths...");
    const fixed = fixFigmaAssets();
    if (fixed > 0) ok(`Fixed ${fixed} file(s)`);
    else ok("No fixes needed");

    log("Building...");
    execSync("npm run build", { stdio: "inherit" });
    ok("Build complete");

    if (!fs.existsSync(DIST_DIR)) {
      err("dist/ not found after build");
      process.exit(1);
    }

    log("Uploading files...");
    await uploadDist(creds, domain);
    ok("Files uploaded");
  }

  // Step 5: Caddy
  log("Checking Caddy config...");
  await configureCaddy(creds, domain, type);

  console.log(`\n\x1b[32m\x1b[1m✓ Deployed!\x1b[0m https://${domain}\n`);
}

main().catch((e) => {
  err(e.message);
  process.exit(1);
});
