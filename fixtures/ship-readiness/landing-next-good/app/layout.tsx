export const metadata = {
  title: 'Good Landing',
  description: 'A small landing page.',
  openGraph: {
    title: 'Good Landing',
    description: 'A small landing page.',
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
