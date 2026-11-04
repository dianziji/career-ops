import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDF_PROTOCOL, sharedPdfSocketPath } from '../lib/pdf-server.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('shared painters isolate socket identity by PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'co-pdf-execpath-'));
  const savedExecPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const savedSocket = process.env.CAREER_OPS_PDF_SOCKET;
  const savedRoot = process.env.CAREER_OPS_ROOT;
  const savedDataDir = process.env.CAREER_OPS_DATA_DIR;
  try {
    delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    delete process.env.CAREER_OPS_PDF_SOCKET;
    process.env.CAREER_OPS_ROOT = dir;
    delete process.env.CAREER_OPS_DATA_DIR;
    const defaultSocket = sharedPdfSocketPath(ROOT);

    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '/custom/chrome';
    const customSocket = sharedPdfSocketPath(ROOT);
    assert.notEqual(defaultSocket, customSocket);

    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = '   ';
    const blankSocket = sharedPdfSocketPath(ROOT);
    assert.equal(defaultSocket, blankSocket);
  } finally {
    if (savedExecPath === undefined) delete process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    else process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = savedExecPath;
    if (savedSocket === undefined) delete process.env.CAREER_OPS_PDF_SOCKET;
    else process.env.CAREER_OPS_PDF_SOCKET = savedSocket;
    if (savedRoot === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = savedRoot;
    if (savedDataDir === undefined) delete process.env.CAREER_OPS_DATA_DIR;
    else process.env.CAREER_OPS_DATA_DIR = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shared painters isolate socket identity by protocol, so a painter left running from the previous code is not reused', () => {
  // A painter outlives an update by up to its idle timeout. Before #6377 it
  // wrote an over-budget warn-only render to the output path and reported no
  // draft; a client of this code reading that reply would log the PDF as
  // generated. The client never reaches it: the socket name differs.
  const dir = mkdtempSync(join(tmpdir(), 'co-pdf-protocol-'));
  const savedSocket = process.env.CAREER_OPS_PDF_SOCKET;
  const savedRoot = process.env.CAREER_OPS_ROOT;
  const savedDataDir = process.env.CAREER_OPS_DATA_DIR;
  try {
    delete process.env.CAREER_OPS_PDF_SOCKET;
    process.env.CAREER_OPS_ROOT = dir;
    delete process.env.CAREER_OPS_DATA_DIR;
    const current = sharedPdfSocketPath(ROOT);
    assert.equal(current, sharedPdfSocketPath(ROOT, { protocol: PDF_PROTOCOL }), 'the default is the current protocol');
    assert.notEqual(current, sharedPdfSocketPath(ROOT, { protocol: PDF_PROTOCOL - 1 }), 'the previous protocol lives at another socket');
  } finally {
    if (savedSocket === undefined) delete process.env.CAREER_OPS_PDF_SOCKET;
    else process.env.CAREER_OPS_PDF_SOCKET = savedSocket;
    if (savedRoot === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = savedRoot;
    if (savedDataDir === undefined) delete process.env.CAREER_OPS_DATA_DIR;
    else process.env.CAREER_OPS_DATA_DIR = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
