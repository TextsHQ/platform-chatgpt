export const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Electron/24.0.0 Safari/537.36'

// div[role=dialog] makes sure we don't close window when "Your session has expired. Please log in again to continue using the app." dialog is showing up
export const CLOSE_ON_AUTHENTICATED_JS = 'if (window.__NEXT_DATA__?.props?.pageProps?.user && !document.querySelector("div[role=dialog]")) setTimeout(() => window.close(), 500)'
