# Game ID Checker API

A fast and efficient API for checking player IDs from various games on Midasbuy.

## Features

- Check player IDs from multiple games (currently supports Honor of Kings and PUBG Mobile)
- Fast response times with optimized browser automation
- Concurrent request handling with intelligent queuing
- Easy to extend for additional games
- Web interface for cookie management

## API Endpoints

- `GET /api/{gameId}/{playerId}` - Check a player ID for a specific game
- `GET /api/supportedgames` - List all supported games and their endpoints
- `GET /status` - View current server status, active requests, and queue sizes
- `GET /health` - Check if the server is healthy
- `GET /cookieupload` - Web interface for uploading cookies
- `POST /api/upload-cookies` - Upload new cookies via API

## Supported Games

- Honor of Kings (`hok`)
- PUBG Mobile (`pubg`)

## Example Usage

```
GET /api/hok/5113048677740798346
```

Response:
```json
{
  "game": "hok",
  "id": "5113048677740798346",
  "name": "CaiRi",
  "during": "1.13"
}
```

## Setup

1. Clone this repository
2. Install dependencies: `npm install`
3. Create a `cookies.json` file with your Midasbuy cookies or use the cookie upload interface
4. Start the server: `npm start`

## Cookie Management

You can upload cookies in two ways:

1. **Web Interface**: Access `/cookieupload` in your browser
2. **API Endpoint**: Send a POST request to `/api/upload-cookies` with:
   ```json
   {
     "cookies": "[{\"name\":\"cookie1\",\"value\":\"value1\",...}]",
     "password": "your_upload_password"
   }
   ```

## Environment Variables

- `PORT` - Port to run the server on (default: 3000)
- `COOKIES_JSON` - JSON string of cookies (alternative to cookies.json file)
- `UPLOAD_PASSWORD` - Password for cookie uploads (default: "admin123")

## Deployment

This project is deployed on Railway through GitHub integration.

## License

MIT 