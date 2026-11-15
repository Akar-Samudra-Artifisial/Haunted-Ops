/** The first focusable element of the page. It moves focus to the table region (and keeps the URL as it is). */
export function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#services"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById('services')?.focus();
      }}
    >
      Skip to services
    </a>
  );
}
