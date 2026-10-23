import { finale } from '../../content/marketing';

export function Finale() {
  return (
    <div className="wrap">
      <section className="finale" id={finale.id} aria-labelledby="finale-title">
        <div className="mist" aria-hidden="true" />
        <div className="floor" aria-hidden="true" />
        <h2 id="finale-title">
          {finale.titleLead} <b>{finale.titleAccent}</b>
        </h2>
        <div className="fin-ctas">
          <a href={finale.primaryCta.href} className="btn btn-dark">
            {finale.primaryCta.label}
          </a>
          <a href={finale.secondaryCta.href} className="btn btn-outline-dark">
            {finale.secondaryCta.label}
          </a>
        </div>
      </section>
    </div>
  );
}
