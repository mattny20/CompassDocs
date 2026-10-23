// Directory export download links (1.15.0): the link a preset hands out,
// what the landing page asks the export route for, the file name it reads
// back, and the id a new preset is saved under.
//
// Run: npx tsx --tsconfig ./tsconfig.test.json --test test/directory-export-link.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  exportLinkApiPath,
  exportLinkFileLabel,
  exportLinkFormatOptions,
  exportLinkPath,
  exportLinkUrl,
  filenameFromDisposition,
  parseExportLinkFormat,
} from "../src/lib/directory-export-link";
import { presetIdFor } from "../src/components/directory-admin/export/preset-rules";
import { safeReturnPath } from "../src/lib/return-to";

describe("download link", () => {
  test("a PDF link is the bare page; the other formats ride on ?format=", () => {
    assert.equal(exportLinkPath("phone-directory"), "/directory/download/phone-directory");
    assert.equal(exportLinkPath("phone-directory", "pdf"), "/directory/download/phone-directory");
    assert.equal(exportLinkPath("phone-directory", "csv"), "/directory/download/phone-directory?format=csv");
    assert.equal(exportLinkPath("phone-directory", "vcf"), "/directory/download/phone-directory?format=vcf");
  });

  test("an id that needs encoding is encoded, and survives the sign-in return path", () => {
    const path = exportLinkPath("front desk/2", "csv");
    assert.equal(path, "/directory/download/front%20desk%2F2?format=csv");
    // requireUser sends the visitor to /login?next=<this>; it must come back unchanged.
    assert.equal(safeReturnPath(path), path);
  });

  test("the full link sits on the origin given, without a doubled slash", () => {
    assert.equal(exportLinkUrl("https://intranet.example.com", "a"), "https://intranet.example.com/directory/download/a");
    assert.equal(exportLinkUrl("https://intranet.example.com/", "a", "csv"), "https://intranet.example.com/directory/download/a?format=csv");
    assert.equal(exportLinkUrl("", "a"), "/directory/download/a");
  });

  test("the landing page asks the export route for the preset, the format and via=link", () => {
    assert.equal(exportLinkApiPath("phone-directory", "pdf"), "/api/directory/export?preset=phone-directory&format=pdf&via=link");
    assert.equal(exportLinkApiPath("a&b", "vcf"), "/api/directory/export?preset=a%26b&format=vcf&via=link");
  });

  test("the format reads as the export route reads it: anything unknown is a PDF", () => {
    assert.equal(parseExportLinkFormat("csv"), "csv");
    assert.equal(parseExportLinkFormat("VCF"), "vcf");
    assert.equal(parseExportLinkFormat(["csv", "vcf"]), "csv");
    assert.equal(parseExportLinkFormat("xlsx"), "pdf");
    assert.equal(parseExportLinkFormat(undefined), "pdf");
    assert.equal(parseExportLinkFormat(""), "pdf");
  });

  test("a split preset's PDF is called a ZIP, in the picker and in words", () => {
    assert.deepEqual(exportLinkFormatOptions(false).map((o) => o.label), ["PDF", "CSV", "Contact cards (.vcf)"]);
    assert.equal(exportLinkFormatOptions(true)[0].label, "ZIP of PDFs");
    assert.equal(exportLinkFileLabel("pdf"), "PDF");
    assert.equal(exportLinkFileLabel("pdf", true), "ZIP of PDFs, one per section");
    assert.equal(exportLinkFileLabel("csv", true), "CSV spreadsheet");
    assert.equal(exportLinkFileLabel("vcf"), "contact cards (.vcf)");
  });
});

describe("file name from Content-Disposition", () => {
  test("the quoted name the export route sends", () => {
    assert.equal(filenameFromDisposition('attachment; filename="phone-directory.pdf"', "directory.pdf"), "phone-directory.pdf");
  });

  test("RFC 5987 filename* wins over the plain one", () => {
    assert.equal(
      filenameFromDisposition(`attachment; filename="caf.pdf"; filename*=UTF-8''caf%C3%A9.pdf`, "x.pdf"),
      "café.pdf"
    );
  });

  test("an unquoted name, and a missing or broken header, fall back", () => {
    assert.equal(filenameFromDisposition("attachment; filename=list.csv", "x.csv"), "list.csv");
    assert.equal(filenameFromDisposition(null, "directory.csv"), "directory.csv");
    assert.equal(filenameFromDisposition("attachment", "directory.csv"), "directory.csv");
    assert.equal(filenameFromDisposition(`attachment; filename*=UTF-8''%E0%A4%A.pdf`, "d.pdf"), "d.pdf");
  });

  test("a name is never a path", () => {
    assert.equal(filenameFromDisposition('attachment; filename="../../etc/passwd"', "d.pdf"), ".._.._etc_passwd");
    assert.equal(filenameFromDisposition('attachment; filename="a\\\\b.pdf"', "d.pdf"), "a__b.pdf");
  });
});

describe("a new preset's id", () => {
  test("is its name as a slug", () => {
    assert.equal(presetIdFor("Front desk list", new Set()), "front-desk-list");
    assert.equal(presetIdFor("  Who's who (2026)  ", new Set()), "who-s-who-2026");
  });

  test("is numbered past ids already taken", () => {
    assert.equal(presetIdFor("Front desk", new Set(["front-desk"])), "front-desk-2");
    assert.equal(presetIdFor("Front desk", new Set(["front-desk", "front-desk-2", "front-desk-3"])), "front-desk-4");
  });

  test("a name with nothing to slug is 'export'", () => {
    assert.equal(presetIdFor("—", new Set()), "export");
    assert.equal(presetIdFor("", new Set(["export"])), "export-2");
  });

  test("stays inside the server's 40 characters with room for a number, and never ends in a hyphen", () => {
    const long = "Partners and associates of the firm, by office and practice";
    const id = presetIdFor(long, new Set());
    assert.ok(id.length <= 34, id);
    assert.ok(!id.endsWith("-"), id);
    const numbered = presetIdFor(long, new Set([id]));
    assert.ok(numbered.length <= 40, numbered);
  });
});
