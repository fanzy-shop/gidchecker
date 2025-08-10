# Game ID Checker API

A fast and efficient API for checking player IDs from various games on Midasbuy.

## Features

- Check player IDs from multiple games (currently supports Honor of Kings and PUBG Mobile)
- Fast response times with optimized browser automation
- Concurrent request handling with intelligent queuing
- Easy to extend for additional games

## API Endpoints

- `GET /api/{gameId}/{playerId}` - Check a player ID for a specific game
- `GET /api/supportedgames` - List all supported games and their endpoints
- `GET /status` - View current server status, active requests, and queue sizes
- `GET /health` - Check if the server is healthy

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
3. Create a `cookies.json` file with your Midasbuy cookies
4. Start the server: `npm start`

## Environment Variables

- `PORT` - Port to run the server on (default: 3000)

## Deployment

This project is deployed on Railway through GitHub integration.

## License

MIT 