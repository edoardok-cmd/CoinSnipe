import Image from 'next/image';
import { hero } from '../../content/marketing';
import { CoinTabs } from './CoinTabs';

/** Hero (section 2) with the coin tabs panel it docks onto (section 3, id "signals"). */
export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-bg" aria-hidden="true">
        <div className="gridlines" />
        <div className="beam" />
      </div>
      <div className="wrap hero-center">
        <h1 id="hero-title">
          {hero.titleLead}
          <br />
          <span className="grad">{hero.titleAccent}</span>
        </h1>
        <p className="sub">{hero.subline}</p>
        <div className="backed">
          <span>{hero.backedBy}</span>
          {hero.partners.map((p) => (
            <a
              key={p.name}
              href={p.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${p.name} (opens in a new tab)`}
            >
              <Image
                src={p.src}
                alt={p.name}
                width={p.width}
                height={p.height}
                style={{ height: p.name === 'DefiLlama' ? 24 : 22, width: 'auto' }}
                sizes="120px"
              />
            </a>
          ))}
        </div>
        <div className="hero-list" id="signals">
          <div className="junction">
            <a href={hero.primaryCta.href} className="btn btn-mint">
              {hero.primaryCta.label}
            </a>
            <a href={hero.secondaryCta.href} className="btn btn-glass">
              {hero.secondaryCta.label}
            </a>
          </div>
          <CoinTabs />
        </div>
      </div>
    </section>
  );
}
