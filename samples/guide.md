# Reading on Glass

A short guide to Glass Reader, and to why the shape of text on a screen matters more than we usually admit.

## Why this exists

Most of what we read on a laptop arrives wrapped in somebody else's furniture. A PDF viewer brings a toolbar, a thumbnail rail and a zoom menu. A documentation site brings a navigation tree, a search bar, a cookie banner and a footer. An editor brings tabs, a minimap and a file tree. None of these are bad on their own, but together they quietly push the actual words into a narrow corridor in the middle of the screen.

Glass Reader takes the opposite position. When you open a document, everything that is not the text disappears. What remains is the writing itself, laid out on a single sheet of frosted glass, with typography that is chosen for reading rather than for whatever the original app happened to use.

## The five layouts

Each layout is a different answer to the same question: how much of the text should you see at once? Press the number keys to switch between them at any time. Your place in the document is kept as you move between layouts.

1. **Column** is a calm, continuous page. It is the closest to a well-made book page, and the best default for long, steady reading.
2. **Book** lays the text out as a two-page spread. You turn pages instead of scrolling, which many people find easier to keep track of.
3. **Focus** keeps one passage bright in the middle of the screen and fades everything around it, like song lyrics in a story.
4. **Cinema** shows a single passage at a time, large and centred, with nothing else competing for attention.
5. **Prompter** scrolls the text upward at a steady pace, like a teleprompter, so your eyes can stay in one place.

Focus, Cinema and Prompter can also play on their own. Press **P** to start, and use the comma and full stop keys to slow down or speed up. In Focus and Cinema, the words of the current passage light up at your reading speed.

## Typography that holds together

Reading comfort mostly comes down to three numbers that depend on each other: the size of the text, the length of each line, and the space between lines. Change one without the others and the page starts to feel wrong. Lines that are too long make it hard to find the start of the next line. Lines that are too short break the rhythm of a sentence. Tight spacing on a wide column makes the eye slip between lines.

So in Glass Reader, line height is not a fixed setting. It is worked out from the size and the width you choose. Wider columns get a little more air between lines; larger text gets a little less. You can still nudge it with **L**, but the starting point is always a sensible one.

> A comfortable line holds somewhere between fifty and seventy-five characters. Most screens are set up to show twice that, which is why so much reading on a laptop feels like hard work.

The defaults are a serif typeface designed for long-form reading, a line of about sixty-eight characters, and paragraph spacing rather than indents. Press **F** to try a sans-serif or a monospaced face, **I** to switch to book-style indents, and **A** to justify the text.

## Cleaning up the source

Documents rarely arrive in good shape. A PDF does not really contain paragraphs at all: it contains small runs of text, each placed at an exact position on a page. To turn that back into something readable, Glass Reader rebuilds lines from those runs, removes page numbers and the running headers that repeat at the top of every page, joins words that were split with a hyphen at the end of a line, and works out where paragraphs and headings begin from the spacing, indentation and size of the text.

Markdown, Word documents, EPUB books and saved web pages carry more structure, so their headings, lists, quotes, tables and code blocks come through more or less intact. Plain text files are treated with a little suspicion: if a file looks as though it was wrapped by hand at a fixed width, the lines are joined back into flowing paragraphs.

## Keyboard at a glance

| Key | What it does |
| --- | --- |
| 1 – 5 | Column, Book, Focus, Cinema, Prompter |
| Space, arrows | Move through the text |
| P | Play or pause |
| − and + | Text size |
| [ and ] | Line width |
| L | Line height |
| T | Background |
| Esc | Hide the overlay |

Press the question mark at any time to see the full list.

## A note on backgrounds

The default background is a blurred, darkened copy of your desktop wallpaper, so the reader feels like a pane of glass resting over your desktop rather than another window. **Frost** is the light version of the same idea. **Clear** lets the real desktop show through a dark tint. **Night** and **Paper** are solid, quiet backgrounds for long sessions.

## What comes next

This first version reads files that you open yourself. The next steps are to pick up the document you are already reading automatically: the file open in your PDF viewer, the page open in your browser, or the text you have selected anywhere on screen. After that come scanned documents, which need their text recognised from the image, and an optional mode that uses a language model to restructure text that arrives badly broken.

```text
glass-reader --toggle      show or hide the overlay
glass-reader book.epub     open a file straight into the reader
```

Until then, the best way to use it is simple. Open something long that you have been meaning to read, pick a layout, and let the rest of the screen go quiet.
