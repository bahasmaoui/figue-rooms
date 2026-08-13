// Copies the QR encoder's browser build into public/vendor so the invite-link
// page has no runtime dependency on a CDN.
const fs = require("fs");
const path = require("path");

const srcPath = path.join(__dirname, "..", "node_modules", "qrcode-generator", "qrcode.js");
const destFolder = path.join(__dirname, "..", "public", "vendor", "qrcode");
const destPath = path.join(destFolder, "qrcode.js");

fs.mkdirSync(destFolder, { recursive: true });
if (fs.existsSync(srcPath)) {
  fs.copyFileSync(srcPath, destPath);
  console.log("vendored qrcode-generator -> public/vendor/qrcode/qrcode.js");
} else {
  console.warn(`skipped missing ${srcPath}`);
}
