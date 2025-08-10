# Midasbuy ID Checker API

A simple API to check player IDs on Midasbuy.

## Setup

1. Make sure you have Node.js installed
2. Place your Midasbuy cookies in a file named `cookies.json` in the root directory
3. Install dependencies: `npm install`
4. Start the server: `npm start` or `npm run dev` for development mode

## Usage

Send a GET request to:

```
http://localhost:3000/api/{playerId}
```

Replace `{playerId}` with the player ID you want to check.

## Response Format

```json
{
  "id": "5113048677740798346",
  "name": "PlayerName"
}
```

If the player is not found, you'll get a 404 error. 