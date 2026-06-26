export const metadata = {
  title: 'Verified Landing',
  description: 'A landing page with an owned capture endpoint.',
  openGraph: {
    title: 'Verified Landing',
    description: 'A landing page with an owned capture endpoint.',
    images: ['/og.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Verified Landing',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
