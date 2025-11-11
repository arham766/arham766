"use client"

import { useAuth } from "@/contexts/AuthContext"
import { H1 } from "@/components/ui/typography"
import AuthWrapper from "@/components/auth-wrapper"
import { TopUpButton } from "@/components/top-up-button"
import { useState, useEffect } from "react"
import Link from "next/link"
import { TopUpDialog } from "@/components/top-up-dialog"
import { useApiKeys } from "@/hooks/use-api-keys"
import { SkopApi, type JobCreateResponse, type JobStatusResponse, type JobResultsResponse, DEFAULT_SCRAPE_PARAMETERS } from "@/lib/skop-api"
import { supabase } from "@/lib/supabase"
import { sanitizeUrl, sanitizePrompt } from "@/lib/input-sanitizer"

import { Globe, Key, ArrowUp, ChevronDown } from 'lucide-react'
import { DownloadIcon } from '@/components/ui/download'
import { toast } from "sonner"
import { useRouter } from "next/navigation"

function TestContent() {
  const { user, signOut } = useAuth()
  const { apiKeys } = useApiKeys()
  const [isTopUpDialogOpen, setIsTopUpDialogOpen] = useState(false)
  const router = useRouter()
  
  // Form state
  const [mainInput, setMainInput] = useState("")
  const [website, setWebsite] = useState("")
  const [selectedApiKey, setSelectedApiKey] = useState("")
  const [isApiDropdownOpen, setIsApiDropdownOpen] = useState(false)
  const [isMultipage, setIsMultipage] = useState(false)
  const [isForm, setIsForm] = useState(false)
  
  // Processing state
  const [isProcessing, setIsProcessing] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dots, setDots] = useState("")
  const [isCompleted, setIsCompleted] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [isTimeout, setIsTimeout] = useState(false)
  const [startTime, setStartTime] = useState<number | null>(null)
  
  // Job state
  const [currentJob, setCurrentJob] = useState<JobCreateResponse | null>(null)
  const [jobStatus, setJobStatus] = useState<JobStatusResponse | null>(null)
  const [jobResults, setJobResults] = useState<JobResultsResponse | null>(null)

  // Restore saved form data on mount
  useEffect(() => {
    const savedFormData = localStorage.getItem('skop_pending_job')
    if (savedFormData) {
      try {
        const data = JSON.parse(savedFormData)
        setMainInput(data.prompt || "")
        setWebsite(data.website || "")
        setIsMultipage(data.isMultipage || false)
        setIsForm(data.isForm || false)
        // Clear the saved data after restoring
        localStorage.removeItem('skop_pending_job')
        toast.success("Welcome back, let's start scraping!")
      } catch (err) {
        // Error restoring form data - silently continue
      }
    }
  }, [])

  // Set default API key
  useEffect(() => {
    if (apiKeys.length > 0 && !selectedApiKey) {
      setSelectedApiKey(apiKeys[0].name)
    }
  }, [apiKeys, selectedApiKey])

  // Progress animation for 4 minutes (240 seconds)
  useEffect(() => {
    if (isProcessing && !isCompleted && !isTimeout) {
      const progressInterval = setInterval(() => {
        setProgress(prev => {
          const increment = 100 / (240 * 10) // 240 seconds * 10 updates per second
          const newProgress = Math.min(prev + increment, 100)
          
          // Check if 4 minutes have passed
          if (startTime && Date.now() - startTime >= 240000 && newProgress >= 100) {
            setIsTimeout(true)
            toast.error("It's taking longer than expected, please check back on your dashboard in a bit")
          }
          
          return newProgress
        })
      }, 100)

      return () => clearInterval(progressInterval)
    }
  }, [isProcessing, isCompleted, isTimeout, startTime])

  // Quick fill animation when job completes early
  const quickFillProgress = () => {
    const fillInterval = setInterval(() => {
      setProgress(prev => {
        if (prev >= 100) {
          clearInterval(fillInterval)
          setTimeout(() => setIsCompleted(true), 300) // Small delay before showing download button
          return 100
        }
        return prev + 10 // Fill quickly
      })
    }, 50)
  }

  // Dots animation
  useEffect(() => {
    if (isProcessing && !isCompleted) {
      const dotsInterval = setInterval(() => {
        setDots(prev => {
          if (prev === "") return "."
          if (prev === ".") return ".."
          if (prev === "..") return "..."
          return ""
        })
      }, 500)

      return () => clearInterval(dotsInterval)
    }
  }, [isProcessing, isCompleted])

  const updateJobInDatabase = async (jobId: string, status: string, results?: any, cost?: number) => {
    try {
      const updateData: any = { status }
      
      if (status === 'completed') {
        updateData.completed_at = new Date().toISOString()
        updateData.results = results
        updateData.cost = cost || 0
      }

      const { error } = await supabase
        .from('scraping_jobs')
        .update(updateData)
        .eq('job_id', jobId)

      if (error) {
        throw error
      }
    } catch (err) {
      // Error updating job in database
    }
  }

  const updateUserCredits = async (cost: number) => {
    try {
      if (!user) return

      const { data: profileData, error: fetchError } = await supabase
        .from('user_profiles')
        .select('credits_balance, total_spent')
        .eq('id', user.id)
        .single()

      if (fetchError) throw fetchError

      const currentBalance = Number(profileData.credits_balance)
      const currentSpent = Number(profileData.total_spent)
      
      const newBalance = currentBalance - cost
      const newSpent = currentSpent + cost

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({
          credits_balance: newBalance,
          total_spent: newSpent,
          updated_at: new Date().toISOString()
        })
        .eq('id', user.id)

      if (updateError) throw updateError
    } catch (err) {
      // Error updating user credits
    }
  }

  const createUsageLog = async (jobId: string, apiKeyId: string, results: any) => {
    try {
      if (!user) return

      const { error } = await supabase
        .from('usage_logs')
        .insert({
          user_id: user.id,
          api_key_id: apiKeyId,
          job_id: jobId,
          endpoint: '/scrape',
          request_count: 1,
          pages_processed: results.total_pages_crawled || 1,
          documents_found: results.total_documents_found || 0,
          cost: results.cost || 0,
          pages_with_results: results.total_pages_crawled || 1,
          firecrawl_pages: results.total_pages_crawled || 1,
          fast_scraper_pages: 0,
          firecrawl_cost: results.cost || 0,
          fast_scraper_cost: 0
        })

      if (error) throw error
    } catch (err) {
      // Error creating usage log
    }
  }

  const pollJobStatus = async (api: SkopApi, jobId: string, apiKeyId: string) => {
    try {
      const status = await api.getJobStatus(jobId)
      setJobStatus(status)

      await updateJobInDatabase(jobId, status.status)

      if (status.is_active) {
        setTimeout(() => pollJobStatus(api, jobId, apiKeyId), 5000)
      } else if (status.status === 'completed') {
        const results = await api.getJobResults(jobId)
        setJobResults(results)

        const actualCost = results.metadata?.scraper_breakdown?.total_cost || results.cost || 0
        
        await updateJobInDatabase(jobId, 'completed', results, actualCost)
        await updateUserCredits(actualCost)
        await createUsageLog(jobId, apiKeyId, results)
        
        // Job completed early - trigger quick fill animation
        if (progress < 100) {
          quickFillProgress()
        } else {
          setIsCompleted(true)
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to check job status')
    }
  }

const handleSendClick = async () => {
  // Sanitize inputs
  const sanitizedPrompt = sanitizePrompt(mainInput)
  const sanitizedWebsite = sanitizeUrl(website)
  
  if (!sanitizedPrompt || !sanitizedWebsite) {
    toast.error('Please provide valid inputs')
    return
  }

  // Check if user is authenticated
  if (!user) {
    const formData = {
      prompt: sanitizedPrompt,
      website: sanitizedWebsite,
      isMultipage,
      isForm,
      timestamp: Date.now()
    }
    localStorage.setItem('skop_pending_job', JSON.stringify(formData))
    toast.info("Please sign in to continue with your scraping job")
    router.push('/sign-in')
    return
  }

  // ✅ Simulated scraping process (no Supabase / API call)
  setIsProcessing(true)
  setProgress(0)
  setIsCompleted(false)
  setIsTimeout(false)
  setStartTime(Date.now())
  setDots("")

  toast.success("Starting simulated scraping...")

  // Animate progress from 0 → 100% over 10 seconds
  const duration = 10000 // 10s
  const start = Date.now()

  const timer = setInterval(() => {
    const elapsed = Date.now() - start
    const pct = Math.min((elapsed / duration) * 100, 100)
    setProgress(pct)
if (pct >= 100) {
  clearInterval(timer)
  setTimeout(() => {
    setIsProcessing(false)
    setIsCompleted(true)
    toast.success("Found 6000 documents! Preparing ZIP...")

    // 🚀 Automatically show and trigger the ZIP download view
    setTimeout(() => {
      downloadAllDocuments()
    }, 1000)
  }, 500)
}



  const handleCancelClick = () => {
    setIsProcessing(false)
    setProgress(0)
    setDots("")
    setIsCompleted(false)
    setIsTimeout(false)
    setStartTime(null)
    setCurrentJob(null)
    setJobStatus(null)
    setJobResults(null)
  }


 const downloadAllDocuments = async () => {
  setIsDownloading(true)
  try {
    toast.success("Preparing ZIP...")

    const response = await fetch("https://e02845e6ef7c.ngrok-free.app/download", {
      method: "GET",
    })

    if (!response.ok) throw new Error(`Failed (${response.status})`)

    const blob = await response.blob()
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `skop-documents-${Date.now()}.zip`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    window.URL.revokeObjectURL(url)

    toast.success("Download complete!")
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "Download failed")
  } finally {
    setIsDownloading(false)
  }
}

  return (
    <div className="p-6">
      <div className="space-y-12">
        {/* Header with Logo and Account */}
        <div className="flex items-center justify-between">
          <div>
            <H1 className="text-5xl font-bold" style={{ color: '#5A88A4' }}>[skop.dev]</H1>
          </div>
          <div className="flex items-center space-x-3">
            {/* Action Buttons and Account Info */}
            <div className="flex items-center space-x-12">
              {user && (
                <Link href="/dashboard">
                  <button 
                    className="text-xs text-black hover:underline"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    [DASHBOARD]
                  </button>
                </Link>
              )}
              {user && <TopUpButton onClick={() => setIsTopUpDialogOpen(true)} />}
              <a 
                href="https://docs.skop.dev/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-black hover:underline"
                style={{
                  background: 'transparent',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  textDecoration: 'none'
                }}
              >
                [DOCS]
              </a>
              
              {user ? (
                <div className="flex items-center space-x-3">
                  <div className="text-left">
                    <p className="text-xs">{user?.email?.toUpperCase()}</p>
                  </div>
                  <button
                    className="text-xs text-black hover:text-destructive hover:underline transition-colors"
                    onClick={async () => {
                      await signOut()
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    [SIGN OUT]
                  </button>
                </div>
              ) : (
                <Link href="/sign-in">
                  <button 
                    className="text-xs text-black hover:underline"
                    style={{
                      background: 'transparent',
                      border: 'none',
                      display: 'flex',
                      alignItems: 'center'
                    }}
                  >
                    [SIGN IN]
                  </button>
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Hero Section */}
        <div className="flex justify-center items-center min-h-[calc(100vh-200px)]">
          <div style={{
            position: 'relative',
            width: '678px',
            height: '368px'
          }}>
            <div
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                width: '500px',
                height: '500px',
                backgroundColor: '#5A88A4',
                borderRadius: '50%',
                opacity: 0.8,
                filter: 'blur(100px)',
                zIndex: 0,
                pointerEvents: 'none'
              }}
            ></div>
            <h1 style={{
              position: 'absolute',
              top: '21px',
              left: '87px',
              width: '503px',
              margin: 0,
              fontFamily: 'Inter, sans-serif',
              fontWeight: 400,
              fontSize: '40px',
              lineHeight: 1.21,
              letterSpacing: '-1.6px',
              textAlign: 'center',
              color: '#ffffff',
              zIndex: 3
            }}>
              Scrape files <br />with one line of text.
            </h1>
            
            {/* Extracting text - below box */}
            {isProcessing && !isCompleted && !isTimeout && (
              <div style={{
                position: 'absolute',
                top: '230px',
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: '12px',
                color: '#ffffff',
                fontFamily: 'Inter, sans-serif',
                textShadow: '0 0 8px rgba(255, 255, 255, 0.8)',
                zIndex: 4
              }}>
                [EXTRACTING {Math.round(progress)}%]{dots}
              </div>
            )}
            
            {/* Cancel button - below box (only if not timeout) */}
            {isProcessing && !isCompleted && !isTimeout && (
              <button
                onClick={handleCancelClick}
                style={{
                  position: 'absolute',
                  top: '250px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  fontSize: '12px',
                  color: '#ffffff',
                  fontFamily: 'Inter, sans-serif',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  zIndex: 4
                }}
              >
                [CANCEL]
              </button>
            )}
            
            {/* Main input field / Processing view */}
            <div style={{
              position: 'absolute',
              top: '144px',
              left: isCompleted ? '50%' : 0,
              transform: isCompleted ? 'translateX(-50%)' : 'none',
              width: isCompleted ? '300px' : '678px',
              height: isProcessing ? '50px' : '106px',
              backgroundColor: isCompleted ? 'transparent' : (isProcessing ? 'rgba(90, 136, 164, 0.8)' : 'rgba(247, 247, 247, 0.75)'),
              borderRadius: '20px',
              boxShadow: '1px 1px 50px -28px rgba(12, 14, 55, 0.25)',
              zIndex: 2,
              padding: isProcessing ? '5px' : '15px',
              transition: 'all 0.3s ease'
            }}>
              {!isProcessing ? (
                <>
                  <textarea 
                    placeholder="Find board meeting minutes for 2025"
                    value={mainInput}
                    onChange={(e) => setMainInput(e.target.value)}
                    style={{
                      border: 'none',
                      outline: 'none',
                      background: 'transparent',
                      fontSize: '14px',
                      width: 'calc(100% - 30px)',
                      color: '#333',
                      textAlign: 'left',
                      position: 'absolute',
                      top: '15px',
                      left: '15px',
                      right: '15px',
                      resize: 'none',
                      overflow: 'hidden',
                      lineHeight: '1.4',
                      maxHeight: 'calc(14px * 1.4 * 2)',
                      fontFamily: 'Inter, sans-serif',
                      padding: '0',
                      margin: '0',
                      verticalAlign: 'top'
                    }}
                    className="placeholder:text-[#5A88A4] placeholder:opacity-60"
                    rows={2}
                    onInput={(e) => {
                      const target = e.target as HTMLTextAreaElement;
                      target.style.height = 'auto';
                      const scrollHeight = target.scrollHeight;
                      const maxHeight = 14 * 1.4 * 2; // 2 lines max
                      target.style.height = Math.min(scrollHeight, maxHeight) + 'px';
                    }}
                  />
                  
                  {/* Website input at bottom left */}
                  <div style={{
                    position: 'absolute',
                    bottom: '15px',
                    left: '15px',
                    display: 'flex',
                    alignItems: 'center',
                    backgroundColor: '#ffffff',
                    borderRadius: '20px',
                    padding: '6px 8px',
                    width: '135px',
                    height: '22px'
                  }}>
                    <Globe size={14} style={{ color: '#5A88A4', marginRight: '6px' }} />
                    <input 
                      type="text"
                      placeholder="Enter website URL"
                      value={website}
                      onChange={(e) => setWebsite(e.target.value)}
                      style={{
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        fontSize: '12px',
                        width: '100%',
                        color: '#333',
                        textAlign: 'left'
                      }}
                      className="placeholder:text-[#5A88A4] placeholder:opacity-30"
                    />
                  </div>
                  
                  {/* API Key dropdown - only show if user is authenticated */}
                  {user && (
                    <div style={{
                      position: 'absolute',
                      bottom: '15px',
                      left: '160px'
                    }}>
                      <div 
                        onClick={() => setIsApiDropdownOpen(!isApiDropdownOpen)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          backgroundColor: '#ffffff',
                          borderRadius: '20px',
                          padding: '6px 8px',
                          width: '140px',
                          height: '22px',
                          cursor: 'pointer'
                        }}
                      >
                        <Key size={14} style={{ color: '#5A88A4', marginRight: '6px' }} />
                        <span style={{ 
                          fontSize: '12px', 
                          flex: 1,
                          color: '#5A88A4'
                        }}>
                          {selectedApiKey || 'Select API Key'}
                        </span>
                        <ChevronDown size={12} style={{ color: '#5A88A4' }} />
                      </div>
                      
                      {isApiDropdownOpen && (
                        <div style={{
                          position: 'absolute',
                          top: '30px',
                          left: 0,
                          backgroundColor: '#F8F8F8',
                          borderRadius: '8px',
                          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                          width: '140px',
                          zIndex: 10,
                          maxHeight: '120px',
                          overflowY: 'auto'
                        }}>
                          {apiKeys.map((key) => (
                            <div
                              key={key.id}
                              onClick={() => {
                                setSelectedApiKey(key.name)
                                setIsApiDropdownOpen(false)
                              }}
                              style={{
                                padding: '8px 12px',
                                fontSize: '12px',
                                cursor: 'pointer',
                                borderBottom: '1px solid #f0f0f0',
                                color: '#5A88A4'
                              }}
                              onMouseEnter={(e) => (e.target as HTMLElement).style.backgroundColor = '#f8f8f8'}
                              onMouseLeave={(e) => (e.target as HTMLElement).style.backgroundColor = 'transparent'}
                            >
                              {key.name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  
                  {/* Multipage toggle - no background */}
                  <div style={{
                    position: 'absolute',
                    bottom: '15px',
                    left: user ? '310px' : '160px',
                    display: 'flex',
                    alignItems: 'center'
                  }}>
                    <span style={{ fontSize: '12px', color: '#5A88A4', marginRight: '8px' }}>
                      Multipage
                    </span>
                    <div 
                      onClick={() => setIsMultipage(!isMultipage)}
                      style={{
                        width: '32px',
                        height: '16px',
                        backgroundColor: isMultipage ? '#5A88A4' : 'rgba(90, 136, 164, 0.3)',
                        borderRadius: '8px',
                        position: 'relative',
                        cursor: 'pointer',
                        transition: 'background-color 0.2s'
                      }}
                    >
                      <div style={{
                        width: '12px',
                        height: '12px',
                        backgroundColor: '#fff',
                        borderRadius: '50%',
                        position: 'absolute',
                        top: '2px',
                        left: isMultipage ? '18px' : '2px',
                        transition: 'left 0.2s'
                      }}></div>
                    </div>
                  </div>
                  
                  {/* Form toggle - no background */}
                  <div style={{
                    position: 'absolute',
                    bottom: '15px',
                    left: user ? '420px' : '270px',
                    display: 'flex',
                    alignItems: 'center'
                  }}>
                    <span style={{ fontSize: '12px', color: '#5A88A4', marginRight: '8px' }}>
                      Form
                    </span>
                    <div 
                      onClick={() => setIsForm(!isForm)}
                      style={{
                        width: '32px',
                        height: '16px',
                        backgroundColor: isForm ? '#5A88A4' : 'rgba(90, 136, 164, 0.3)',
                        borderRadius: '8px',
                        position: 'relative',
                        cursor: 'pointer',
                        transition: 'background-color 0.2s'
                      }}
                    >
                      <div style={{
                        width: '12px',
                        height: '12px',
                        backgroundColor: '#fff',
                        borderRadius: '50%',
                        position: 'absolute',
                        top: '2px',
                        left: isForm ? '18px' : '2px',
                        transition: 'left 0.2s'
                      }}></div>
                    </div>
                  </div>
                  
                  {/* Send button */}
                  <div style={{
                    position: 'absolute',
                    bottom: '15px',
                    right: '15px',
                    backgroundColor: '#5A88A4',
                    borderRadius: '20px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 2px 8px rgba(90, 136, 164, 0.3)',
                    padding: '8px 12px',
                    width: '35px',
                    height: '35px'
                  }}
                  onClick={handleSendClick}
                  onMouseEnter={(e) => ((e.target as HTMLElement).style.transform = 'scale(1.05)')}
                  onMouseLeave={(e) => ((e.target as HTMLElement).style.transform = 'scale(1)')}
                  >
                    <ArrowUp size={18} style={{ color: '#ffffff' }} />
                  </div>
                </>
              ) : (
                <>
                  {!isCompleted && !isTimeout ? (
                    // Progress bars - full width
                    <div style={{
                      position: 'absolute',
                      top: '10px',
                      left: '10px',
                      right: '10px',
                      bottom: '10px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '1px'
                    }}>
                      {Array.from({ length: 40 }).map((_, i) => {
                        const barProgress = (progress / 100) * 40
                        const isBarCompleted = i < barProgress
                        const isFirst = i === 0
                        const isLast = i === 39
                        
                        let borderRadius = '1px'
                        if (isFirst) borderRadius = '10px 1px 1px 10px'
                        if (isLast) borderRadius = '1px 10px 10px 1px'
                        
                        return (
                          <div
                            key={i}
                            style={{
                              flex: 1,
                              height: '100%',
                              backgroundColor: isBarCompleted ? '#ffffff' : 'rgba(255, 255, 255, 0.3)',
                              borderRadius,
                              boxShadow: isBarCompleted ? '0 0 6px rgba(255, 255, 255, 0.8)' : 'none',
                              transition: 'all 0.2s ease'
                            }}
                          />
                        )
                      })}
                    </div>
                  ) : isTimeout ? (
                    // Timeout state - subtle background
                    <div style={{
                      position: 'absolute',
                      top: '10px',
                      left: '10px',
                      right: '10px',
                      bottom: '10px',
                      backgroundColor: 'rgba(255, 255, 255, 0.1)',
                      borderRadius: '15px'
                    }} />
                  ) : (
                    // Download button with glow
                    <div style={{
                      position: 'absolute',
                      top: '10px',
                      left: '30px',
                      right: '30px',
                      bottom: '10px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 3
                    }}>
                      <button
                        onClick={downloadAllDocuments}
                        disabled={isDownloading}
                        style={{
                          backgroundColor: '#ffffff',
                          color: '#5A88A4',
                          border: 'none',
                          borderRadius: '10px',
                          padding: '8px 16px',
                          fontSize: '12px',
                          fontFamily: 'Inter, sans-serif',
                          cursor: isDownloading ? 'not-allowed' : 'pointer',
                          fontWeight: '500',
                          boxShadow: '0 0 20px rgba(255, 255, 255, 0.8), 0 0 40px rgba(255, 255, 255, 0.4)',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px'
                        }}
                      >
                        <DownloadIcon size={16} />
                        {isDownloading ? 'Creating zip...' : `Download ${jobResults?.documents.length || 0} documents`}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

      </div>

      {/* Top Up Dialog - only show if user is authenticated */}
      {user && (
        <TopUpDialog 
          isOpen={isTopUpDialogOpen} 
          onClose={() => setIsTopUpDialogOpen(false)} 
        />
      )}
    </div>
  )
}

export default function TestPage() {
  return (
    <AuthWrapper requireAuth={false}>
      <TestContent />
    </AuthWrapper>
  )
} 
