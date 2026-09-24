// Newest/oldest toggle for the podcast episode lists (hub cards and the episode-page rail).
(function () {
  document.querySelectorAll("[data-sort-for]").forEach(function (group) {
    var list = document.querySelector(group.getAttribute("data-sort-for"));
    if (!list) return;
    var buttons = group.querySelectorAll("button[data-order]");

    function apply(order) {
      var items = Array.prototype.slice.call(list.children);
      items.sort(function (a, b) {
        var da = a.getAttribute("data-date");
        var db = b.getAttribute("data-date");
        return order === "oldest" ? (da < db ? -1 : 1) : (da < db ? 1 : -1);
      });
      items.forEach(function (li) { list.appendChild(li); });
      buttons.forEach(function (b) {
        b.setAttribute("aria-pressed", b.getAttribute("data-order") === order ? "true" : "false");
      });
    }

    buttons.forEach(function (b) {
      b.addEventListener("click", function () { apply(b.getAttribute("data-order")); });
    });
  });
})();
