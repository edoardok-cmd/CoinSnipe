import { pricing } from '../../content/marketing';
import { CheckIcon } from './ui';

export function Pricing() {
  const { free, pro } = pricing;
  return (
    <section className="sec" id={pricing.id} aria-labelledby="pricing-title">
      <div className="wrap">
        <div className="head">
          <h2 id="pricing-title">
            {pricing.titleLead} <span className="grad">{pricing.titleAccent}</span>
          </h2>
        </div>
        <div className="plans">
          <div className="card plan">
            <div className="plan-head">
              <h3>{free.name}</h3>
            </div>
            <div className="price">{free.price}</div>
            <div className="sub-note">{free.period}</div>
            <ul>
              {free.features.map((f) => (
                <li key={f}>
                  <CheckIcon />
                  {f}
                </li>
              ))}
            </ul>
            <div className="sp" />
            <a href={free.cta.href} className="btn btn-glass">
              {free.cta.label}
            </a>
          </div>
          <div className="card plan pro">
            <div className="plan-head">
              <h3>{pro.name}</h3>
              <span className="pill" style={{ fontSize: 12 }}>
                {pro.badge}
              </span>
            </div>
            <div className="price">{pro.price}</div>
            <div className="sub-note">{pro.period}</div>
            <div className="sub-note">{pro.trial}</div>
            <ul>
              {pro.features.map((f) => (
                <li key={f}>
                  <CheckIcon />
                  {f}
                </li>
              ))}
            </ul>
            <div className="sp" />
            <a href={pro.cta.href} className="btn btn-mint">
              {pro.cta.label}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
