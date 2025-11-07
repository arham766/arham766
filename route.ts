import { NextRequest, NextResponse } from "next/server"
import JSZip from "jszip"
import { validateJobId } from "@/lib/input-sanitizer"
import { createServerClient } from "@/lib/supabase"
import { SkopApi } from "@/lib/skop-api"

// ========================
// Config / Constants
// ========================
const SKOP_API_KEY = process.env.SKOP_API_KEY || ""
const BOARDBOOK_PATTERN = "meetings.boardbook.org/public/Organization/"

// Enhanced download strategies for different types of sites
const DOWNLOAD_STRATEGIES = {
  // Strategy 1: Standard approach (current)
  standard: {
    headers: {
      'Accept': 'application/pdf,application/octet-stream,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Referer': 'https://www.google.com/',
    }
  },
  
  // Strategy 2: Corporate site approach (for sites like Apple)
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
  
  // Strategy 3: Direct document access
  direct: {
    headers: {
      'Accept': 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
    }
  },
  
  // Strategy 4: Mobile user agent (often less restricted)
  mobile: {
    headers: {
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    }
  },

  // Strategy 5: Form automation specific (for newer job types)
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

  // Strategy 6: Government site approach
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

  // Strategy 7: Watermark/session-based approach
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

  // Strategy 8: Aggressive approach with minimal headers
  aggressive: {
    headers: {
      'Accept': '*/*',
    }
  }
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0'
]

// ========================
// Security Helpers
// ========================
function isValidDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    
    // Block internal/private networks
    const hostname = parsed.hostname.toLowerCase()
    
    // Block localhost and private IPs
    if (hostname === 'localhost' || 
        hostname === '127.0.0.1' ||
        hostname.startsWith('192.168.') ||
        hostname.startsWith('10.') ||
        hostname.startsWith('172.16.') ||
        hostname.startsWith('169.254.') ||
        hostname === '0.0.0.0' ||
        hostname.includes('internal') ||
        hostname.includes('local')) {
      return false
    }
    
    // Only allow HTTPS (with HTTP for dev)
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return false
    }
    
    return true
  } catch {
    return false
  }
}

// ========================
// Download Helpers
// ========================
async function downloadWithStrategy(
  doc: any,
  strategy: string,
  userAgent: string,
  attempt: number = 1
): Promise<{ success: boolean, data?: ArrayBuffer, error?: string }> {
  // SECURITY: Validate URL before downloading
  if (!isValidDocumentUrl(doc.url)) {
    return { success: false, error: 'Invalid or blocked URL' }
  }
  
  const strategyConfig = DOWNLOAD_STRATEGIES[strategy as keyof typeof DOWNLOAD_STRATEGIES]
  const baseUrl = new URL(doc.url)
  
  // Dynamic referer and origin based on strategy and URL
  let referer = 'https://www.google.com/'
  let origin = undefined
  
  if (strategy === 'corporate' || strategy === 'watermark') {
    referer = `${baseUrl.protocol}//${baseUrl.host}/`
    origin = `${baseUrl.protocol}//${baseUrl.host}`
  }
  
  let headers: Record<string, string> = {
    ...strategyConfig.headers,
    'User-Agent': userAgent,
  }

  // Add referer conditionally instead of deleting
  if (strategy !== 'direct' && strategy !== 'aggressive') {
    headers['Referer'] = referer
  }
  
  // Add origin for watermark strategy
  if (strategy === 'watermark' && origin) {
    headers['Origin'] = origin
  }

  try {
    // Use longer timeout for watermark URLs and government sites (maintaining reliability)
    const timeout = doc.url.includes('OverlayWatermark') || doc.url.includes('publicaccess') || doc.url.includes('hillsclerk')
      ? 90000 // 90s for watermark and government sites (restored for reliability)
      : 45000 // 45s for others (restored for reliability)
    
    const response = await fetch(doc.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeout),
    })

    if (response.ok) {
      const arrayBuffer = await response.arrayBuffer()
      
      // SECURITY: Limit file size to prevent DoS (100MB max)
      if (arrayBuffer.byteLength > 100 * 1024 * 1024) {
        return { success: false, error: 'File too large (max 100MB)' }
      }
      
      // Enhanced content validation for government docs and PDFs
      if (arrayBuffer.byteLength > 500) { // Reduced minimum size check
        const uint8Array = new Uint8Array(arrayBuffer)
        const header = Array.from(uint8Array.slice(0, 10)).map(b => b.toString(16).padStart(2, '0')).join('')
        
        // PDF signature: 25504446 (%PDF)
        // ZIP signatures: 504b0304, 504b0506, 504b0708
        // Office docs often start with: 504b or d0cf
        const isPDF = header.startsWith('25504446')
        const isZIPOffice = header.startsWith('504b')
        const isOldOffice = header.startsWith('d0cf')
        const isHTML = arrayBuffer.byteLength < 50000 && // Small files that might be error pages
                      (header.includes('3c68746d6c') || header.includes('3c21444f43')) // <html or <!DOC
        
        // For watermark URLs, be more lenient as they might have wrapper content  
        const isWatermarkURL = strategy === 'watermark' || strategy === 'government'
        
        const isValidDocument = isPDF || 
                               isZIPOffice || 
                               isOldOffice || 
                               (isWatermarkURL && arrayBuffer.byteLength > 1000 && !isHTML) || // Watermark docs, avoid HTML errors
                               arrayBuffer.byteLength > 50000 // Large file, likely valid document
        
        if (isValidDocument) {
          return { success: true, data: arrayBuffer }
        } else {
          // Log what we got instead of a valid document
          const textStart = new TextDecoder('utf-8', { fatal: false }).decode(uint8Array.slice(0, 200))
          return { 
            success: false, 
            error: `Invalid document content (got ${arrayBuffer.byteLength} bytes, header: ${header.slice(0, 20)}, text: ${textStart.slice(0, 50)})` 
          }
        }
      }
    }
    
    return { 
      success: false, 
      error: `HTTP ${response.status}: ${response.statusText} (Strategy: ${strategy}, Attempt: ${attempt})` 
    }
  } catch (error: any) {
    return { 
      success: false, 
      error: `${error.message} (Strategy: ${strategy}, Attempt: ${attempt})` 
    }
  }
}

async function downloadDocumentWithFallbacks(doc: any, index: number): Promise<{ success: boolean, data?: ArrayBuffer, errors: string[] }> {
  // Determine strategies based on URL characteristics
  let strategies: string[] = []

  if (doc.url.includes('OverlayWatermark')) {
    strategies = ['watermark', 'form_automation', 'government', 'standard', 'corporate', 'direct', 'mobile', 'aggressive']
  } else if (doc.url.includes('publicaccess') || doc.url.includes('hillsclerk')) {
    strategies = ['government', 'form_automation', 'watermark', 'standard', 'corporate', 'direct', 'mobile', 'aggressive']
  } else if (doc.url.includes('form') || doc.url.includes('automation')) {
    strategies = ['form_automation', 'government', 'standard', 'corporate', 'direct', 'mobile', 'aggressive']
  } else {
    strategies = ['standard', 'form_automation', 'corporate', 'direct', 'mobile', 'government', 'aggressive']
  }

  const errors: string[] = []
  const maxAttemptsPerStrategy = 2 // Restored to 2 for reliability
  
  for (const strategy of strategies) {
    for (let attempt = 1; attempt <= maxAttemptsPerStrategy; attempt++) {
      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
      
      // Add delay between attempts to avoid rate limiting
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
      }
      
      const result = await downloadWithStrategy(doc, strategy, userAgent, attempt)
      
      if (result.success && result.data) {
        return { success: true, data: result.data, errors }
      }
      
      if (result.error) {
        errors.push(result.error)
      }
      
      // If we got a specific error that suggests we should try a different approach
      if (result.error?.includes('403') || result.error?.includes('401') || result.error?.includes('429')) {
        break // Try next strategy immediately for auth/rate limit errors
      }
      
      // For timeout errors, try the next strategy with a longer delay
      if (result.error?.includes('timeout') || result.error?.includes('ETIMEDOUT')) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
      }
    }
    
    // Brief pause between strategies
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  
  return { success: false, errors }
}

// ========================
// Skop (scrape) helpers
// ========================
async function runSkopScrapeAndGetDocuments(websiteUrl: string) {
  if (!SKOP_API_KEY) {
    throw new Error("Missing SKOP_API_KEY")
  }

  const skop = new SkopApi(SKOP_API_KEY)

  // 1) Create scrape job
  const job = await skop.createScrapeJob({
    website: websiteUrl,
    prompt: "Extract all public meeting documents.",
    parameters: {
      single_page: false,
      timeout: 1800,
      confidence_threshold: 0.1,
      file_type: "document",
      max_file_size_mb: 100,
      form: false,
    },
  })

  // 2) Poll for completion (bounded)
  const MAX_WAIT_MS = 10 * 60 * 1000 // 10 minutes max waiting
  const POLL_INTERVAL_MS = 8000
  const start = Date.now()
  let status = await skop.getJobStatus(job.job_id)

  while (status.status === "pending" || status.status === "in_progress") {
    if (Date.now() - start > MAX_WAIT_MS) break
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
    status = await skop.getJobStatus(job.job_id)
  }

  if (status.status !== "completed") {
    throw new Error(`Scrape job not completed: ${status.status}`)
  }

  // 3) Fetch results
  const results = await skop.getJobResults(job.job_id)
  return {
    documents: results.documents || [],
    total: results.total_documents_found || results.documents?.length || 0,
    jobId: job.job_id,
  }
}

// ========================
// Route Handler
// ========================
export async function POST(request: NextRequest) {
  try {
    // SECURITY: Authenticate user before allowing downloads
    const supabase = await createServerClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Parse body - allow multiple keys so it's flexible with callers
    const body = await request.json().catch(() => ({} as any))
    const { documents: documentsFromBody, jobId, input, websiteUrl, url } = body as {
      documents?: any[],
      jobId?: string,
      input?: string,
      websiteUrl?: string,
      url?: string
    }

    // ==============================
    // NEW: Auto-handle BoardBook URL
    // ==============================
    const possibleUrl = (websiteUrl || input || url || "").toString()
    let documents: any[] | undefined = documentsFromBody

    if (possibleUrl && possibleUrl.includes(BOARDBOOK_PATTERN)) {
      // Run the Skop scrape for the boardbook meetings URL to get all docs
      try {
        const { documents: scrapedDocs, jobId: skopJobId, total } = await runSkopScrapeAndGetDocuments(possibleUrl)
        console.log(`✅ Skop scrape complete for BoardBook (${total} docs, job ${skopJobId})`)
        documents = scrapedDocs?.map((d, idx) => ({
          url: d.url,
          name: d.name || `document_${idx + 1}`,
          title: d.name || d.source_page || `document_${idx + 1}`,
          document_type: d.document_type || "document",
          source_page: d.source_page || "",
          content_type: d.document_type || "application/pdf",
          global_index: idx,
        })) || []
      } catch (err: any) {
        console.error("❌ Skop scrape failed:", err?.message || err)
        return NextResponse.json({ error: "Failed to scrape BoardBook URL", detail: err?.message || String(err) }, { status: 502 })
      }
    }

    // ==============================
    // Existing validation / flow
    // ==============================
    // Validate inputs
    if (!documents || !Array.isArray(documents)) {
      return NextResponse.json(
        { error: "Missing or invalid documents array" },
        { status: 400 }
      )
    }

    // SECURITY: Limit number of documents to prevent DoS
    if (documents.length > 500) {
      return NextResponse.json(
        { error: "Too many documents requested (max 500)" },
        { status: 400 }
      )
    }

    if (jobId && !validateJobId(jobId)) {
      return NextResponse.json(
        { error: "Invalid job ID format" },
        { status: 400 }
      )
    }

    const zip = new JSZip()
    let successfulDownloads = 0
    let failedDownloads = 0
    const downloadLogs: any[] = []

    // Process documents in parallel with controlled concurrency
    const BATCH_SIZE = 25 // Process 25 documents at a time (balanced speed/stability)
    const batches: any[][] = []
    
    for (let i = 0; i < documents.length; i += BATCH_SIZE) {
      batches.push(documents.slice(i, i + BATCH_SIZE))
    }

    console.log(`🚀 Processing ${documents.length} documents in ${batches.length} batches of ${BATCH_SIZE}`)

    // Process batches with limited concurrency for stability
    const MAX_CONCURRENT_BATCHES = 2 // Max 2 batches at once to prevent crashes

    // Process batches sequentially in groups to prevent server crashes
    for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
      const currentBatches = batches.slice(i, i + MAX_CONCURRENT_BATCHES)
      console.log(`⚡ Processing batch group ${Math.floor(i / MAX_CONCURRENT_BATCHES) + 1}: batches ${i + 1}-${Math.min(i + MAX_CONCURRENT_BATCHES, batches.length)}`)

      const batchPromises = currentBatches.map(async (batch, localBatchIndex) => {
        const batchIndex = i + localBatchIndex
        console.log(`  🔄 Starting batch ${batchIndex + 1}/${batches.length} (${batch.length} documents)`)

        const docPromises = batch.map(async (doc, localIndex) => {
          const globalIndex = batchIndex * BATCH_SIZE + localIndex
          const result = await downloadDocumentWithFallbacks(doc, globalIndex)
          
          if (result.success && result.data) {
            // Create unique filename to prevent overwrites
            let baseName = doc.name || doc.title || `document_${globalIndex + 1}`
            baseName = baseName.replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_')
            
            // Add unique identifiers to prevent filename conflicts
            let uniqueSuffix = ''
            if (doc.row_number) {
              uniqueSuffix = `_row${doc.row_number}`
            }
            if (doc.global_index !== undefined) {
              uniqueSuffix += `_idx${doc.global_index}`
            } else {
              uniqueSuffix += `_idx${globalIndex}`
            }
            
            let fileExtension = 'pdf'
            const docType = doc.document_type || doc.content_type
            if (docType) {
              if (docType.includes('pdf') || docType === 'application/pdf') {
                fileExtension = 'pdf'
              } else if (docType.includes('zip')) {
                fileExtension = 'zip'
              } else if (docType.includes('doc')) {
                fileExtension = docType.includes('docx') ? 'docx' : 'doc'
              }
            }
            
            if ((doc.url || "").includes('OverlayWatermark') || (doc.url || "").includes('Watermark')) {
              fileExtension = 'pdf'
            }
            
            if (result.data && result.data.byteLength > 4) {
              const uint8Array = new Uint8Array(result.data)
              const header = Array.from(uint8Array.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('')
              if (header.startsWith('25504446')) {
                fileExtension = 'pdf'
              } else if (header.startsWith('504b')) {
                fileExtension = docType?.includes('docx') ? 'docx' : 'zip'
              }
            }
            
            let folderPath = ''
            if (doc.context_id && doc.page_number) {
              folderPath = `Page_${doc.page_number}/`
            } else if (doc.source_page) {
              const pageNum = (doc.source_page as string).match(/page[\s_-]*(\d+)/i)?.[1] || '1'
              folderPath = `Page_${pageNum}/`
            }
            
            // Construct final unique filename
            const fileName = `${baseName}${uniqueSuffix}.${fileExtension}`

            return {
              success: true,
              fileName: folderPath + fileName,
              data: result.data,
              url: doc.url,
              size: result.data.byteLength
            }
          } else {
            return {
              success: false,
              fileName: doc.name || doc.title || `document_${globalIndex + 1}`,
              url: doc.url,
              errors: result.errors
            }
          }
        })

        const batchResults = await Promise.all(docPromises)
        console.log(`  ✅ Batch ${batchIndex + 1} complete: ${batchResults.filter(r => r.success).length}/${batch.length} successful`)
        return batchResults
      })

      // Wait for current batch group to complete
      const groupResults = await Promise.all(batchPromises)
      
      // Process results
      for (const batchResults of groupResults) {
        for (const result of batchResults as any[]) {
          if (result.success && result.data) {
            zip.file(result.fileName, result.data)
            successfulDownloads++
            downloadLogs.push({
              url: result.url,
              fileName: result.fileName,
              status: 'success',
              size: result.size
            })
          } else {
            failedDownloads++
            downloadLogs.push({
              url: result.url,
              fileName: result.fileName,
              status: 'failed',
              errors: result.errors
            })
          }
        }
      }
      
      console.log(`📊 Batch group complete: ${successfulDownloads}/${documents.length} total successful so far`)
    }

    // Log final summary
    console.log(`Download complete: ${successfulDownloads}/${documents.length} successful, ${failedDownloads} failed`)

    if (successfulDownloads === 0) {
      return NextResponse.json(
        { 
          error: "No documents could be downloaded",
          successfulDownloads,
          failedDownloads,
          totalDocuments: documents.length,
          downloadLogs
        },
        { status: 400 }
      )
    }

    // Generate ZIP file
    const zipBuffer = await zip.generateAsync({ 
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    })

    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
    const zipFileName = `skop-documents-${jobId || 'unknown'}-${timestamp}.zip`

    // Return the ZIP file with enhanced headers
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
    })

  } catch (error) {
    // Silent error handling for production
    return NextResponse.json(
      { 
        error: "Internal server error during download",
        message: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}

