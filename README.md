# Midasbuy ID Checker API

A Node.js API to check player IDs on Midasbuy for various games.

## Features

- Check player IDs for multiple games (Honor of Kings, PUBG Mobile)
- Upload cookies via web interface or file upload
- High-performance page pooling for concurrent requests
- Detailed status monitoring

## API Endpoints

- `/api/{gameId}/{playerId}` - Check a player ID for a specific game
- `/api/supportedgames` - List all supported games and their endpoints
- `/cookieupload` - Web interface for uploading Midasbuy cookies
- `/status` - View API status and active requests
- `/health` - Health check endpoint

## Local Development

1. Clone the repository
2. Install dependencies:
   ```
   cd backend
   npm install
   ```
3. Start the server:
   ```
   npm start
   ```
4. Access the API at `http://localhost:3000`

## Deploying to Railway

1. Fork this repository to your GitHub account
2. Create a new project on [Railway](https://railway.app/)
3. Connect your GitHub repository to Railway
4. Deploy the project
5. After deployment, upload your Midasbuy cookies via the `/cookieupload` endpoint

## Environment Variables

No environment variables are required by default. The server runs on port 3000 or the port specified by the `PORT` environment variable.

## Cookies

The API requires Midasbuy cookies to function properly. You can upload your cookies via the `/cookieupload` endpoint after deployment.

## License

ISC 