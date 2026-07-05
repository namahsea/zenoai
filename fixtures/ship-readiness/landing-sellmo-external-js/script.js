document.addEventListener('DOMContentLoaded', () => {
  const headerCta = document.querySelector('.nav-cta');
  const betaSection = document.querySelector('.beta-signup');

  headerCta?.addEventListener('click', () => {
    betaSection?.scrollIntoView({ behavior: 'smooth' });
  });
});
