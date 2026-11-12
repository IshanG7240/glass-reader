# Contributing to Glass Reader

Thanks for helping. A few things keep it easy for everyone.

## Reporting a problem

Open an issue with:

- where you were reading (browser extension, iPad, Android, desktop) and on what site;
- the line at the very bottom of the document ("Read from ChatGPT's own API…", "Read from the page…"), which says how the page was read;
- a share link to the conversation or the page's address, if you can share it;
- a screenshot of what came out wrong.

## Changing the code

1. Fork the repository and create a branch from `main`.
2. `npm install`, make your change, and rebuild what it touches (see *Build from source* in the README).
3. Run the tests for what you changed: `npm run test:extension` and `npm run test:ios` (they run offline and save screenshots you can look at).
4. Open a pull request against `main` describing what changed and why, with a screenshot for anything visible.

`main` is protected: changes land through pull requests, after review by the maintainer.

## Where things are

The reader itself is `renderer/` and is shared by every version. Reading pages (chats, articles, GitHub, Google Docs) is `extract()` in `extension/browser/background.js`, also shared. *Layout of the code* in the README lists the rest.

Keep pages private: Glass Reader never sends what it reads anywhere, and changes shouldn't either.
