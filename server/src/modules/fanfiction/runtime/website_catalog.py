import importlib
import pkgutil


def website_catalog():
    from fanficfare import adapters

    # Adapter login methods include inherited eFiction, XenForo and OTW support.
    # Use the installed adapters rather than a second, incomplete website list.
    logins = {'www.scribblehub.com'}  # BookOrbit supplies this login implementation.
    for module in pkgutil.iter_modules(adapters.__path__):
        if not module.name.startswith('adapter_'):
            continue
        adapter = importlib.import_module('fanficfare.adapters.' + module.name).getClass()
        if any(callable(getattr(adapter, method, None)) for method in ('performLogin', '_login')):
            logins.add(adapter.getConfigSection())
    return [{'id': site, 'examples': urls[:3], 'supportsPasswordLogin': site in logins}
            for site, urls in adapters.getSiteExamples()
            if site.removeprefix('www.') not in {'test1.com', 'test2.com', 'test3.com', 'test4.com'}]
