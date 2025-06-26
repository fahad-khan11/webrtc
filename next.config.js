/** @type {import('next').NextConfig} */
const nextConfig = {
  // Add this to make static files in public directory accessible
  reactStrictMode: true,
  // Enable serving static files from the public directory
  images: {
    domains: [],
  },
  // Fix any error handling issues
  onDemandEntries: {
    // period (in ms) where the server will keep pages in the buffer
    maxInactiveAge: 25 * 1000,
    // number of pages that should be kept simultaneously without being disposed
    pagesBufferLength: 2,
  }
}

module.exports = nextConfig
