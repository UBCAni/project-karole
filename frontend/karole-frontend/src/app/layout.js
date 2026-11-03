import { Dela_Gothic_One, Figtree } from "next/font/google";
import "./globals.css";

// The same pairing as ubcani.com: a chunky display face for headings, Figtree for everything else.
const display = Dela_Gothic_One({
  variable: "--font-display",
  weight: "400",
  subsets: ["latin"],
});

const body = Figtree({
  variable: "--font-body",
  subsets: ["latin"],
});

export const metadata = {
  title: "UBCANI Karaoke",
  description: "Karaoke Manager!",
};

export const viewport = {
  themeColor: "#0f125b",
  // Lets the navy run under the notch; pages pad themselves with the safe-area insets.
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
