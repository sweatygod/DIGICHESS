# DigiChess Multiplayer Guide

## How to Use Play vs Friend

### For the First Player (Creating a Game):
1. Click the **"Play vs Friend"** button in the navigation
2. Click **"Generate Join Code"** in the modal
3. You'll receive a **4-digit code** (e.g., `3847`)
4. Click **"Copy Code"** to copy it to your clipboard
5. Share this code with your friend via chat/email/phone
6. The game board will appear - you play as **White** (pieces at bottom)
7. Wait for your friend to join

### For the Second Player (Joining a Game):
1. Click the **"Play vs Friend"** button
2. Enter the **4-digit code** your friend gave you in the input box
3. Click **"Join Game"**
4. You'll join the game and play as **Black** (pieces at top)
5. The board will sync automatically

## How It Works

- **Join Codes**: Random 4-digit codes stored in Firebase Realtime Database
- **Real-time Sync**: All moves sync instantly between players
- **Turn-based**: The game enforces turn rules automatically
- **Game State**: Board, move history, and game status sync in real-time

## Technical Details

- Built with Firebase Realtime Database
- Each game is stored at `games/{code}` in Firebase
- Moves sync automatically via `syncMoveToFriend()`
- Real-time listeners track opponent's moves
- Works on desktop and mobile browsers

## Troubleshooting

- **Code not found**: Double-check the 4-digit code
- **Game is full**: Each game only allows 2 players
- **Moves not syncing**: Refresh the page (check internet connection)
- **Connection lost**: The game will try to reconnect automatically

Enjoy playing! ♟️
