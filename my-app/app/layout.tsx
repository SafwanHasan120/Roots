import type { Metadata } from "next";
import { Playfair_Display, Montserrat } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next"
import { ResumeProvider } from "@/context/ResumeContext";
import { FavoritesProvider } from "@/context/FavoritesContext";
import { TailorProvider } from "@/context/TailorContext";
import { AuthProvider } from "@/context/AuthContext";
import NavBar from "@/components/NavBar";
import ResumeModal from "@/components/ResumeModal";
import TailorModal from "@/components/TailorModal";

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-playfair",
  display: "swap",
});

const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Roots",
  description:
    "A curated, premium dashboard of Summer 2027 internships. Search, filter, and apply with calm and clarity.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${playfair.variable} ${montserrat.variable}`}>
      <body className="min-h-screen antialiased">
        <AuthProvider>
          <FavoritesProvider>
            <TailorProvider>
              <ResumeProvider>
                <NavBar />
                <ResumeModal />
                <TailorModal />
                {children}
              </ResumeProvider>
            </TailorProvider>
          </FavoritesProvider>
        </AuthProvider>
        <Analytics/>
      </body>
    </html>
  );
}
