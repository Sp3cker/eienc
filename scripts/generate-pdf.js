import puppeteer from 'puppeteer'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import kill from 'tree-kill'

// Configuration
const OUTPUT_PDF = 'encounter-tables.pdf'
const PORT = 4321 // Astro preview default port

async function startPreviewServer() {
  console.log('Starting preview server...')

  return new Promise((resolve, reject) => {
    const previewProcess = spawn('npm', ['run', 'preview'], {
      stdio: 'pipe',
      cwd: process.cwd(),
      detached: false,
      windowsHide: true
    })

    previewProcess.stdout.on('data', (data) => {
      const output = data.toString()
      console.log(output)

      // Look for the server URL in the output
      if (output.includes('Local:') || output.includes('localhost')) {
        // Give the server a moment to fully start
        setTimeout(() => {
          resolve(previewProcess)
        }, 1000)
      }
    })

    previewProcess.stderr.on('data', (data) => {
      console.error(`Preview server error: ${data}`)
    })

    previewProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Preview server failed with exit code ${code}`))
      }
    })

    // Timeout after 10 seconds
    setTimeout(() => {
      reject(new Error('Preview server failed to start within 10 seconds'))
    }, 10000)
  })
}

async function generatePDF() {
  console.log('Launching Puppeteer...')

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    const page = await browser.newPage()

    // Set a larger viewport for better rendering
    await page.setViewport({
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1
    })

    console.log(`Navigating to http://localhost:${PORT}...`)
    await page.goto(`http://localhost:${PORT}`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    })

    // Wait for any fonts to load
    await page.evaluateHandle('document.fonts.ready')

    // Add CSS to hide header on first two pages
    await page.addStyleTag({
      content: `
        @media print {
          @page:first {
            margin-top: 0mm;
          }
          @page :nth(2) {
            margin-top: 0mm;
          }
          @page {
            margin-top: 10mm;
          }
        }
      `
    })

    console.log('Generating PDF...')
    await page.pdf({
      path: OUTPUT_PDF,
      format: 'A4',
      printBackground: true,
      margin: {
        top: '10mm',
        right: '0mm',
        bottom: '0mm',
        left: '0mm'
      },
      // Enable CSS page break support
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="
          font-size: 10px; 
          width: 100%; 
          height: 0mm;
          display: flex;
          background: transparent;
          align-items: center;
          justify-content: center;
          margin: 0; 
          padding: 0;
          font-family: Arial, sans-serif;
          color: #333;
          -webkit-print-color-adjust: exact;
        ">
          <span class="pageNumber"></span>
        </div>
      `,
      footerTemplate: '<div style="width: 100%; font-size: 10px;"></div>'
    })

    console.log(`PDF generated successfully: ${OUTPUT_PDF}`)
  } catch (error) {
    console.error('Error generating PDF:', error)
    throw error
  } finally {
    await browser.close()
  }
}

async function killProcess(process) {
  return new Promise((resolve) => {
    if (!process || process.killed) {
      resolve()
      return
    }

    console.log(`Killing process tree for PID: ${process.pid}`)

    // Use tree-kill to kill the entire process tree
    kill(process.pid, 'SIGTERM', (err) => {
      if (err) {
        console.log('Error during graceful shutdown, forcing kill...')
        kill(process.pid, 'SIGKILL', (err) => {
          if (err) {
            console.log('Error during force kill:', err.message)
          }
          resolve()
        })
      } else {
        console.log('Preview server stopped successfully')
        resolve()
      }
    })
  })
}

async function main() {
  let previewProcess = null

  try {

    // Start preview server
    previewProcess = await startPreviewServer()
    globalPreviewProcess = previewProcess // Store globally for signal handling

    // Generate PDF
    await generatePDF()
  } catch (error) {
    console.error('Error:', error.message)
    return 1
  } finally {
    // Clean up: kill preview server
    if (previewProcess) {
      console.log('Stopping preview server...')
      await killProcess(previewProcess)
      globalPreviewProcess = null
    }
  }

  return 0
}

// Handle command line arguments
const args = process.argv.slice(2)
if (args.includes('--rebuild')) {
  // Force rebuild by removing dist directory
  if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true })
  }
}

// Handle process termination signals
let globalPreviewProcess = null

async function cleanup() {
  if (globalPreviewProcess) {
    console.log('\nCleaning up preview server...')
    await killProcess(globalPreviewProcess)
    globalPreviewProcess = null
  }
}

process.on('SIGINT', async () => {
  await cleanup()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await cleanup()
  process.exit(0)
})

process.on('exit', async () => {
  await cleanup()
})

// Run the main function and handle the result
main()
  .then((exitCode) => {
    process.exit(exitCode)
  })
  .catch(async (error) => {
    console.error('Unhandled error:', error)
    await cleanup()
    process.exit(1)
  })
