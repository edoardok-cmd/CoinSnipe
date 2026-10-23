import { faq } from '../../content/marketing';
import { PlusIcon } from './ui';

/** Native <details>: keyboard and screen-reader support without client JavaScript. */
export function Faq() {
  return (
    <section className="sec" id={faq.id} aria-labelledby="faq-title">
      <div className="wrap">
        <div className="head">
          <h2 id="faq-title">
            {faq.titleLead} <span className="grad">{faq.titleAccent}</span>
          </h2>
        </div>
        <div className="faq-list">
          {faq.items.map((item) => (
            <details className="card faq-item" key={item.q}>
              <summary>
                {item.q}
                <PlusIcon />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
