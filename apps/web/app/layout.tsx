import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import './globals.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { VenueBar } from '../components/VenueBar';

export const metadata: Metadata = {
  title: 'trade-replay',
  description: "Replay a trader's position from open to close.",
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en">
      <body className="min-h-screen bg-tr-bg text-tr-text antialiased">
        <VenueBar />
        {children}
      </body>
    </html>
  );
}
