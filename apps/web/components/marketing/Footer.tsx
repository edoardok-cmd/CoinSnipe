import { footer } from '../../content/marketing';
import { Logogram } from './ui';

export function Footer() {
  return (
    <footer>
      <div className="wrap">
        <div className="fgrid">
          <div className="fbrand">
            <a href="#top" className="brand" aria-label="CoinSnipe, back to top">
              <Logogram size={26} />
              CoinSnipe
            </a>
            <p style={{ marginTop: 14, maxWidth: 300, fontSize: 14, color: 'var(--cs-muted)' }}>
              {footer.tagline}
            </p>
          </div>
          {footer.columns.map((col) => (
            <nav className="fcol" key={col.title} aria-label={col.title}>
              <h2>{col.title}</h2>
              {col.links.map((l) => (
                <a key={l.label} href={l.href}>
                  {l.label}
                </a>
              ))}
            </nav>
          ))}
        </div>
        <div className="legal">
          <span>{footer.disclaimer}</span>
          <span>{footer.company}</span>
        </div>
      </div>
    </footer>
  );
}
