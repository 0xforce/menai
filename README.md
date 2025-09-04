# Uber Eats Menu Viewer

A modern, clean web application that scrapes and displays complete restaurant menus from Uber Eats consumer pages using Playwright.

## Features

- 🍽️ **Complete Menu Display**: View full restaurant menus with categories, items, prices, and modifiers
- 🔍 **Smart Store ID Extraction**: Input either a store ID directly or paste the full Uber Eats restaurant URL
- 📱 **Responsive Design**: Modern, mobile-friendly interface built with Tailwind CSS
- ⚡ **Real-time Loading**: Loading states and error handling for better UX
- 🎨 **Clean UI**: Beautiful, intuitive interface with proper typography and spacing

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
npm i -D playwright
npx playwright install --with-deps
```

### 2. Run the Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Usage

1. **Enter Store Information**: 
   - Paste the full Uber Eats URL (e.g., `https://www.ubereats.com/store/palenque-homemade-colombian-food/WFoN8F22TNGmk4AjVtm8NQ`)
   - Or paste just the Store ID; we’ll normalize to a URL

2. **View Menu**: Click "Get Menu" to fetch and display the complete restaurant menu

3. **Browse**: Navigate through menu categories, view item details, prices, and available modifiers

## Example

Try with the example restaurant:
- **Store ID**: `WFoN8F22TNGmk4AjVtm8NQ`
- **Restaurant**: Palenque Homemade Colombian Food
- **Full URL**: `https://www.ubereats.com/store/palenque-homemade-colombian-food/WFoN8F22TNGmk4AjVtm8NQ`

## API Endpoints

- `GET /api/scrape-menu?url=...` - Scrapes the Uber Eats page and returns normalized menu JSON
- `GET /api/menu/[storeId]` - Convenience route that builds the store URL and scrapes
- `GET /api/google/oauth/start` - Begin Google OAuth
- `GET /api/google/oauth/callback` - OAuth redirect handler
- `GET /api/google/oauth/status` - Check connection status
- `GET /api/google/access-token` - Short-lived access token for Drive Picker
- `POST /api/google/logout` - Disconnect and clear cookie

## Tech Stack

- **Framework**: Next.js 15 with App Router
- **Styling**: Tailwind CSS
- **Language**: TypeScript
- **API**: Uber Eats API v2

## Important Notes

- **Legal/ToS**: Scraping may violate site terms; use responsibly and at your own risk
- **Fragility**: Consumer site structure can change; adjust selectors/mapping as needed
- **Performance**: Playwright runs headless Chromium per request; cache aggressively for production

## Troubleshooting
## Environment

Create `.env.local` with:

```
TEMPLATE_SPREADSHEET_ID=your_template_sheet_id
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_API_KEY=...
OAUTH_COOKIE_SECRET=any-long-random-string-or-base64
```

Notes:
- No database. OAuth tokens are encrypted and stored in a secure cookie.
- Users should have read access to the template to copy it. Easiest is link-viewer.
- If no folder is chosen, exports go to My Drive root.


### "Failed to authenticate" Error
- Check your `UBER_CLIENT_ID` and `UBER_CLIENT_SECRET` in `.env.local`
- Ensure your Uber developer account has the proper scopes

### "Store not found" Error
- Verify the store ID is correct
- Ensure your API credentials have access to that specific store
- Some stores may not be available via the API

### Menu Not Loading
- Check browser developer console for detailed error messages
- Verify the store ID format (should be 22 characters)
- Ensure the restaurant is available for delivery in your region

## License

MIT License - feel free to use this project as a starting point for your own applications.