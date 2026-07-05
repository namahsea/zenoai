export const metadata = {
  title: 'Bad Waitlist',
  description: 'A landing page with an unwired waitlist.',
  openGraph: {
    title: 'Bad Waitlist',
    description: 'A landing page with an unwired waitlist.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
