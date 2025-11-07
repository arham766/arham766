// app/api/download/route.ts
import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { validateJobId } from "@/lib/input-sanitizer";
import { createServerClient } from "@/lib/supabase";
import { SkopApi } from "@/lib/skop-api";
import { google, Auth, Drive } from "googleapis";
import { GaxiosResponse } from "gaxios";

// ========================
// Config / Constants
// ========================
const SKOP_API_KEY = process.env.SKOP_API_KEY || "";
const GOOGLE_DRIVE_FALLBACK_FOLDER_ID = process.env.GOOGLE_DRIVE_FALLBACK_FOLDER_ID || "";

// BoardBook URL detection
function isBoardBookUrl(url: string): boolean {
  const normalized = url.toLowerCase().trim();
  return normalized.includes('meetings.boardbook.org/public/organization');
}

// Normalize URL
function normalizeUrl(url: string): string {
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return `https://${url}`;
  }
  return url;
}

// ========================
// Google Drive Setup
// ========================
let driveClient: Drive.Drive | null = null;

function getDriveClient(): Drive.Drive {
  if (driveClient) return driveClient;

  const keyStr = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyStr) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY missing");

  let credentials;
  try {
    credentials = JSON.parse(keyStr);
  } catch (err) {
    throw new Error(`Invalid GOOGLE_SERVICE_ACCOUNT_KEY: ${err}`);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

// ========================
// Google Drive: Download Folder (with Subfolders)
// ========================
interface DriveFile {
  name: string;
  data: ArrayBuffer;
  mimeType: string;
  path: string;
}

async function downloadGoogleDriveFolder(folderId: string): Promise<DriveFile[]> {
  if (!folderId) throw new Error("GOOGLE_DRIVE_FALLBACK_FOLDER_ID not set");

  const drive = getDriveClient();
  const files: DriveFile[] = [];

  const fetchRecursive = async (parentId: string, currentPath: string = "") => {
    let pageToken: string | undefined;
    do {
      const res: GaxiosResponse<Drive.Schema$FileList> = await drive.files.list({
        q: `'${parentId}' in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size)",
        pageSize: 100,
        pageToken,
      });

      const fileList = res.data.files || [];
      const downloadPromises = fileList.map(async (file) => {
        if (!file.id || !file.name) return null;
        if (file.mimeType === "application/vnd.google-apps.folder") {
          const subPath = currentPath ? `${currentPath}/${file.name}` : file.name;
          await fetchRecursive(file.id!, subPath);
          return null;
        }

        try {
          const dl = await drive.files.get(
            { fileId: file.id!, alt: "media" },
            { responseType: "arraybuffer" }
          );
          const buffer = Buffer.from(dl.data as ArrayBuffer);
          const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
          const filePath = currentPath ? `${currentPath}/${file.name}` : file.name;

          return {
            name: file.name,
            data: arrayBuffer,
            mimeType: file.mimeType || "application/octet-stream",
            path: filePath,
          };
        } catch (err: any) {
          console.error(`Drive download failed: ${file.name}`, err.message);
          return null;
        }
      });

      const results = await Promise.all(downloadPromises);
      results.forEach((f) => f && files.push(f));
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  };

  await fetchRecursive(folderId);
  console.log(`Google Drive: ${files.length} files downloaded`);
  return files;
}

// ========================
// Enhanced Download Strategies (FULLY RESTORED)
// ========================
const DOWNLOAD_STRATEGIES = {
  standard: {
    headers: {
      'Accept': 'application/pdf,application/octet-stream,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Referer': 'https://www.google.com/',
    }
  },
  corporate: {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1',
    }
  },
  direct: {
    headers: {
      'Accept': 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    }
  },
  mobile: {
    headers: {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    }
  },
  form_automation: {
    headers: {
      'Accept': 'application/pdf,application/octet-stream,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
    }
  },
  government: {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'max-age=0',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      'Upgrade-Insecure-Requests': '1',
    }
  },
  watermark: {
    headers: {
      'Accept': 'application/pdf,application/octet-stream,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Upgrade-Insecure-Requests': '1',
    }
  },
  aggressive: {
    headers: { 'Accept': '*/*' }
  }
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
];

// ========================
// Security Helpers
// ========================
function isValidDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' ||
        hostname.startsWith('192.168.') || hostname.startsWith('10.') ||
        hostname.startsWith('172.16.') || hostname.startsWith('169.254.') ||
        hostname === '0.0.0.0' || hostname.includes('internal') || hostname.includes('local')) {
      return false;
    }
    return ['https:', 'http:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

// ========================
// FULL Download Strategy (RESTORED)
// ========================
async function downloadWithStrategy(
  doc: any,
  strategy: string,
  userAgent: string,
  attempt: number = 1
): Promise<{ success: boolean; data?: ArrayBuffer; error?: string }> {
  if (!isValidDocumentUrl(doc.url)) {
    return { success: false, error: 'Invalid or blocked URL' };
  }

  const strategyConfig = DOWNLOAD_STRATEGIES[strategy as keyof typeof DOWNLOAD_STRATEGIES];
  const baseUrl = new URL(doc.url);
  let referer = 'https://www.google.com/';
  let origin: string | undefined;

  if (strategy === 'corporate' || strategy === 'watermark') {
    referer = `${baseUrl.protocol}//${baseUrl.host}/`;
    origin = `${baseUrl.protocol}//${baseUrl.host}`;
  }

  let headers: Record<string, string> = {
    ...strategyConfig.headers,
    'User-Agent': userAgent,
  };
  if (strategy !== 'direct' && strategy !== 'aggressive') {
    headers['Referer'] = referer;
  }
  if (strategy === 'watermark' && origin) {
    headers['Origin'] = origin;
  }

  try {
    const timeout = doc.url.includes('OverlayWatermark') || doc.url.includes('publicaccess') || doc.url.includes('hillsclerk')
      ? 90000 : 45000;

    const response = await fetch(doc.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    });

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > 100 * 1024 * 1024) {
        return { success: false, error: 'File too large (max 100MB)' };
      }

      if (arrayBuffer.byteLength > 500) {
        const uint8Array = new Uint8Array(arrayBuffer);
        const header = Array.from(uint8Array.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join('');
        const isPDF = header.startsWith('25504446');
        const isZIPOffice = header.startsWith('504b');
        const isOldOffice = header.startsWith('d0cf');
        const isHTML = arrayBuffer.byteLength < 50000 &&
          (header.includes('3c68746d6c') || header.includes('3c21444f43'));
        const isWatermarkURL = strategy === 'watermark' || strategy === 'government';

        const isValidDocument = isPDF || isZIPOffice || isOldOffice ||
          (isWatermarkURL && arrayBuffer.byteLength > 1000 && !isHTML) ||
          arrayBuffer.byteLength > 50000;

        if (isValidDocument) {
          return { success: true, data: arrayBuffer };
        } else {
          const textStart = new TextDecoder('utf-8', { fatal: false }).decode(uint8Array.slice(0, 200));
          return {
            success: false,
            error: `Invalid content (header: ${header.slice(0, 20)}, text: ${textStart.slice(0, 50)})`
          };
        }
      }
    }

    return {
      success: false,
      error: `HTTP ${response.status}: ${response.statusText} (Strategy: ${strategy}, Attempt: ${attempt})`
    };
  } catch (error: any) {
    return { success: false, error: `${error.message} (Strategy: ${strategy}, Attempt: ${attempt})` };
  }
}

async function downloadDocumentWithFallbacks(doc: any, index: number): Promise<{ success: boolean; data?: ArrayBuffer; errors: string[] }> {
  let strategies: string[] = [];
  if (doc.url.includes('OverlayWatermark')) {
    strategies = ['watermark', 'form_automation', 'government', 'standard', 'corporate', 'direct', 'mobile', 'aggressive'];
  } else if (doc.url.includes('publicaccess') || doc.url.includes('hillsclerk')) {
    strategies = ['government', 'form_automation', 'watermark', 'standard', 'corporate', 'direct', 'mobile', 'aggressive'];
  } else if (doc.url.includes('form') || doc.url.includes('automation')) {
    strategies = ['form_automation', 'government', 'standard', 'corporate', 'direct', 'mobile', 'aggressive'];
  } else {
    strategies = ['standard', 'form_automation', 'corporate', 'direct', 'mobile', 'government', 'aggressive'];
  }

  const errors: string[] = [];
  const maxAttemptsPerStrategy = 2;

  for (const strategy of strategies) {
    for (let attempt = 1; attempt <= maxAttemptsPerStrategy; attempt++) {
      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      if (attempt > 1) await new Promise(r => setTimeout(r, 1000 * attempt));
      const result = await downloadWithStrategy(doc, strategy, userAgent, attempt);
      if (result.success && result.data) return { success: true, data: result.data, errors };
      if (result.error) errors.push(result.error);
      if (result.error?.includes('403') || result.error?.includes('401') || result.error?.includes('429')) break;
      if (result.error?.includes('timeout') || result.error?.includes('ETIMEDOUT')) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return { success: false, errors };
}

// ========================
// Skop Scrape (FULLY RESTORED)
// ========================
async function runSkopScrapeAndGetDocuments(websiteUrl: string) {
  if (!SKOP_API_KEY) throw new Error("Missing SKOP_API_KEY");
  const skop = new SkopApi(SKOP_API_KEY);
  const normalizedUrl = normalizeUrl(websiteUrl);
  console.log(`Normalized URL for scraping: ${normalizedUrl}`);

  const job = await skop.createScrapeJob({
    website: normalizedUrl,
    prompt: "Extract all public meeting documents.",
    parameters: {
      single_page: false,
      timeout: 1800,
      confidence_threshold: 0.1,
      file_type: "document",
      max_file_size_mb: 100,
      form: false,
    },
  });
  console.log(`Scrape job created: ${job.job_id}`);

  const MAX_WAIT_MS = 10 * 60 * 1000;
  const POLL_INTERVAL_MS = 8000;
  const start = Date.now();
  let status = await skop.getJobStatus(job.job_id);
  while (status.status === "pending" || status.status === "in_progress") {
    if (Date.now() - start > MAX_WAIT_MS) throw new Error(`Scrape job timed out after 10 minutes`);
    console.log(`Job ${job.job_id} status: ${status.status}, waiting...`);
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    status = await skop.getJobStatus(job.job_id);
  }
  if (status.status !== "completed") throw new Error(`Scrape job failed with status: ${status.status}`);
  console.log(`Scrape job completed: ${job.job_id}`);
  const results = await skop.getJobResults(job.job_id);
  return {
    documents: results.documents || [],
    total: results.total_documents_found || results.documents?.length || 0,
    jobId: job.job_id,
  };
}

// ========================
// Main POST Handler (FULLY RESTORED + GOOGLE DRIVE)
// ========================
export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({} as any));
    const { documents: documentsFromBody, jobId, input, websiteUrl, url } = body as {
      documents?: any[];
      jobId?: string;
      input?: string;
      websiteUrl?: string;
      url?: string;
    };
    let documents: any[] | undefined = documentsFromBody;
    const possibleUrl = (websiteUrl || input || url || "").toString().trim();

    // ==============================
    // PRIORITY: BoardBook → Google Drive
    // ==============================
    if (possibleUrl && isBoardBookUrl(possibleUrl)) {
      console.log(`BoardBook URL detected → Using Google Drive folder`);

      if (!GOOGLE_DRIVE_FALLBACK_FOLDER_ID) {
        return NextResponse.json({ error: "Google Drive folder ID not configured" }, { status: 500 });
      }

      try {
        const driveFiles = await downloadGoogleDriveFolder(GOOGLE_DRIVE_FALLBACK_FOLDER_ID);
        if (driveFiles.length === 0) {
          return NextResponse.json({ error: "No files in Google Drive folder" }, { status: 404 });
        }

        documents = driveFiles.map((f, i) => ({
          url: `drive://folder/${f.path}`,
          name: f.name,
          title: f.name,
          document_type: f.mimeType,
          source_page: "",
          content_type: f.mimeType,
          global_index: i,
          confidence_score: 1.0,
          source: "google-drive",
          rawData: f.data,
          path: f.path,
        }));
      } catch (err: any) {
        console.error("Google Drive failed:", err);
        return NextResponse.json({ error: "Failed to download from Google Drive", detail: err.message }, { status: 502 });
      }
    }
    // ==============================
    // Fallback: Skop Scrape
    // ==============================
    else if (possibleUrl && !documents) {
      try {
        const { documents: scrapedDocs } = await runSkopScrapeAndGetDocuments(possibleUrl);
        documents = scrapedDocs.map((d: any, idx: number) => ({
          url: d.url,
          name: d.name || `document_${idx + 1}`,
          title: d.name || d.source_page || `document_${idx + 1}`,
          document_type: d.document_type || "document",
          source_page: d.source_page || "",
          content_type: d.document_type || "application/pdf",
          global_index: idx,
          confidence_score: d.confidence_score,
        }));
      } catch (err: any) {
        return NextResponse.json({ error: "Scrape failed", detail: err.message }, { status: 502 });
      }
    }

    if (!documents || !Array.isArray(documents) || documents.length === 0) {
      return NextResponse.json({ error: "No documents to download" }, { status: 400 });
    }
    if (documents.length > 500) {
      return NextResponse.json({ error: "Too many documents (max 500)" }, { status: 400 });
    }
    if (jobId && !validateJobId(jobId)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    const zip = new JSZip();
    let successfulDownloads = 0;
    let failedDownloads = 0;
    const downloadLogs: any[] = [];

    // Add Google Drive files
    for (const doc of documents) {
      if (doc.source === "google-drive" && doc.rawData) {
        const safePath = doc.path.replace(/[\/\\:*?"<>|]/g, '_');
        zip.file(`Google_Drive/${safePath}`, doc.rawData);
        successfulDownloads++;
        downloadLogs.push({ url: "Google Drive", fileName: safePath, status: "success", size: doc.rawData.byteLength });
        continue;
      }
    }

    // Process scraped docs with FULL batching
    const BATCH_SIZE = 25;
    const batches: any[][] = [];
    const scrapedDocs = documents.filter(d => d.source !== "google-drive");
    for (let i = 0; i < scrapedDocs.length; i += BATCH_SIZE) {
      batches.push(scrapedDocs.slice(i, i + BATCH_SIZE));
    }

    const MAX_CONCURRENT_BATCHES = 2;
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
      const currentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
      const batchPromises = currentBatches.map(async (batch, localIdx) => {
        const batchIdx = i + localIdx;
        const docPromises = batch.map(async (doc, localIndex) => {
          const globalIndex = batchIdx * BATCH_SIZE + localIndex;
          const result = await downloadDocumentWithFallbacks(doc, globalIndex);

          if (result.success && result.data) {
            let baseName = doc.name || doc.title || `document_${globalIndex + 1}`;
            baseName = baseName.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_');
            let uniqueSuffix = '';
            if (doc.row_number) uniqueSuffix += `_row${doc.row_number}`;
            uniqueSuffix += doc.global_index !== undefined ? `_idx${doc.global_index}` : `_idx${globalIndex}`;

            let fileExtension = 'pdf';
            const docType = doc.document_type || doc.content_type;
            if (docType) {
              if (docType.includes('pdf')) fileExtension = 'pdf';
              else if (docType.includes('zip')) fileExtension = 'zip';
              else if (docType.includes('doc')) fileExtension = docType.includes('docx') ? 'docx' : 'doc';
            }
            if ((doc.url || "").includes('OverlayWatermark') || (doc.url || "").includes('Watermark')) {
              fileExtension = 'pdf';
            }
            if (result.data.byteLength > 4) {
              const header = Array.from(new Uint8Array(result.data).slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('');
              if (header.startsWith('25504446')) fileExtension = 'pdf';
              else if (header.startsWith('504b')) fileExtension = docType?.includes('docx') ? 'docx' : 'zip';
            }

            let folderPath = '';
            if (doc.context_id && doc.page_number) folderPath = `Page_${doc.page_number}/`;
            else if (doc.source_page) {
              const m = (doc.source_page as string).match(/page[\s_-]*(\d+)/i);
              folderPath = m ? `Page_${m[1]}/` : '';
            }

            const fileName = `${baseName}${uniqueSuffix}.${fileExtension}`;
            return { success: true, fileName: folderPath + fileName, data: result.data, url: doc.url, size: result.data.byteLength };
          } else {
            return { success: false, fileName: doc.name || `doc_${globalIndex}`, url: doc.url, errors: result.errors };
          }
        });
        return await Promise.all(docPromises);
      });

      const groupResults = await Promise.all(batchPromises);
      for (const batchResults of groupResults) {
        for (const r of batchResults) {
          if (r.success && r.data) {
            zip.file(r.fileName, r.data);
            successfulDownloads++;
            downloadLogs.push({ url: r.url, fileName: r.fileName, status: 'success', size: r.size });
          } else {
            failedDownloads++;
            downloadLogs.push({ url: r.url, fileName: r.fileName, status: 'failed', errors: r.errors });
          }
        }
      }
    }

    if (successfulDownloads === 0) {
      return NextResponse.json({ error: "No files downloaded", downloadLogs }, { status: 400 });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const zipFileName = `skop-documents-${jobId || 'drive'}-${timestamp}.zip`;

    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipFileName}"`,
        'Content-Length': zipBuffer.length.toString(),
        'X-Successful-Downloads': successfulDownloads.toString(),
        'X-Failed-Downloads': failedDownloads.toString(),
        'X-Total-Documents': documents.length.toString(),
        'X-Download-Logs': JSON.stringify(downloadLogs)
      }
    });
  } catch (error: any) {
    console.error("Route error:", error);
    return NextResponse.json({ error: "Server error", message: error.message }, { status: 500 });
  }
}
