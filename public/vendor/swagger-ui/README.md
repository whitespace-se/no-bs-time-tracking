# Swagger UI, vendored

`swagger-ui.css` and `swagger-ui-bundle.js` from `swagger-ui-dist@5.32.15`, copied verbatim.

They are committed rather than loaded from a CDN because an instance is meant to run anywhere
the customer puts it, including a network that cannot reach one. A documentation
page that goes blank behind a firewall is a documentation page that fails exactly when
somebody is trying to work out why nothing else reaches the internet either.

To refresh:

    npm install --no-save swagger-ui-dist@5
    cp node_modules/swagger-ui-dist/swagger-ui.css node_modules/swagger-ui-dist/swagger-ui-bundle.js public/vendor/swagger-ui/

Nothing imports them at build time; `/docs` loads them as static files.
