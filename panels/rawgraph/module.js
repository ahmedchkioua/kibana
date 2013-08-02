/*jshint globalstrict:true */
/*global angular:true */

/*

  ## Raw graph

  A bucketted time series representation of the current query or queries.
  Note that this panel DOESN-T uses facetting.

  ### Parameters
  * query ::  an array of objects as such: {query: 'somequery', label 'legent text'}.
              this is usually populated by a stringquery panel wher the query and label
              parameter are the same
  * interval :: Datapoint interval in elasticsearch date math format (eg 1d, 1w, 1y, 5y)
  * fill :: Only applies to line charts. Level of area shading from 0-10
  * linewidth ::  Only applies to line charts. How thick the line should be in pixels
                  While the editor only exposes 0-10, this can be any numeric value.
                  Set to 0 and you'll get something like a scatter plot
  * timezone :: This isn't totally functional yet. Currently only supports browser and utc.
                browser will adjust the x-axis labels to match the timezone of the user's
                browser
  * spyable ::  Dislay the 'eye' icon that show the last elasticsearch query
  * zoomlinks :: Show the zoom links?
  * lines :: Line chart? Sweet.
  * legend :: Show the legend?
  * x-axis :: Show x-axis labels and grid lines
  * y-axis :: Show y-axis labels and grid lines
  * interactive :: Allow drag to select time range

*/

'use strict';

angular.module('kibana.rawgraph', [])
.controller('rawgraph', function($scope, eventBus, query, dashboard, filterSrv) {

  // Set and populate defaults
  var _d = {
    status      : "Alpha",
    group       : "default",
    query       : [ {query: "*", label:"Query"} ],
    max_point   : 5000,
    time_field  : '@timestamp',
    series : [ {value_field : null, hide: false} ],
    fill        : 0,
    linewidth   : 1,
    timezone    : 'browser', // browser, utc or a standard timezone
    spyable     : true,
    zoomlinks   : true,
    bars        : false,
    stack       : false,
    points      : false,
    lines       : true,
    legend      : true,
    'x-axis'    : true,
    'y-axis'    : true,
    percentage  : false,
    interactive : true,
  };
  _.defaults($scope.panel,_d);

  $scope.init = function() {

    $scope.queries = query;

    $scope.$on('refresh',function(){
      $scope.get_data();
    });

    $scope.get_data();

  };

  $scope.get_data = function(segment,query_id) {
    delete $scope.panel.error;

    // Make sure we have everything for the request to complete
    if(dashboard.indices.length === 0) {
      return;
    }

    $scope.panel.loading = true;
    var _segment = _.isUndefined(segment) ? 0 : segment;
    var request = $scope.ejs.Request().indices(dashboard.indices[_segment]);

    var boolQuery = $scope.ejs.BoolQuery();
    _.each(query.list,function(q) {
      boolQuery = boolQuery.should($scope.ejs.QueryStringQuery(q.query || '*'));
    });
    // Build the query
    request = request.query(
      $scope.ejs.FilteredQuery(
        boolQuery,
        filterSrv.getBoolFilter(filterSrv.ids)
      ))
      .highlight(
        $scope.ejs.Highlight($scope.panel.highlight)
        .fragmentSize(2147483647) // Max size of a 32bit unsigned int
        .preTags('@start-highlight@')
        .postTags('@end-highlight@')
      )
      .size($scope.panel.max_point)
      .sort($scope.panel.time_field, "desc");

    // Populate the inspector panel
    $scope.populate_modal(request);

    // Then run it
    var results = request.doSearch();

    // Populate scope when we have results
    results.then(function(results) {
      $scope.panel.loading = false;

      if(_segment === 0) {
        $scope.hits = 0;
        $scope.data = [];
        query_id = $scope.query_id = new Date().getTime();
      }

      // Check for error and abort if found
      if(!(_.isUndefined(results.error))) {
        $scope.panel.error = $scope.parse_error(results.error);
        return;
      }

      // Check that we're still on the same query, if not stop
      if($scope.query_id === query_id) {
        $scope.data= $scope.data.concat(_.map(results.hits.hits, function(hit) {
          return {
            _source   : kbn.flatten_json(hit._source),
            highlight : kbn.flatten_json(hit.highlight||{})
          };
        }));

        $scope.hits += results.hits.total;

        // Create the flot series object for visible series
        $scope.plotseries = [];
        _.each($scope.panel.series, function(item, index) {
          if (!item.hide) {
            $scope.plotseries.push({
                data: [],
                hits: 0,
                info: {
                  alias:item.value_field,
                  color: $scope.queries.colors[index],
                }
            });
          }
        });

        // Get data and assign in their own series
        _.each($scope.data, function(item_data, index_data) {
          // Not convinced by that
          var cached_time_field=null;
          _.each($scope.plotseries, function(item_series, index_series) {
            if (typeof item_data._source[item_series.info.alias] === 'number'
             && typeof item_data._source[$scope.panel.time_field] !== 'undefined' && item_data._source[$scope.panel.time_field] !== null ) {
              if (cached_time_field === null)
              {
                // Timestamp parsing
                var parts = item_data._source[$scope.panel.time_field].split('T'),
                dateParts = parts[0].split('-'),
                timeParts = parts[1].split('Z'),
                timeSubParts = timeParts[0].split(':'),
                timeSecParts = timeSubParts[2].split('.'),
                _date = new Date;
                _date.setUTCFullYear(Number(dateParts[0]));
                _date.setUTCMonth(Number(dateParts[1])-1);
                _date.setUTCDate(Number(dateParts[2]));
                _date.setUTCHours(Number(timeSubParts[0]));
                _date.setUTCMinutes(Number(timeSubParts[1]));
                _date.setUTCSeconds(Number(timeSecParts[0]));
                if (timeSecParts[1]) _date.setUTCMilliseconds(Number(timeSecParts[1]));

                cached_time_field=_date.getTime()
              }

              $scope.plotseries[index_series].data.push([cached_time_field, item_data._source[item_series.info.alias]]);
              $scope.plotseries[index_series].hits += 1;
            }
          });
        });

        // Tell the histogram directive to render.
        $scope.$emit('render');

      } else {
        return;
      }

    });
  };

  // function $scope.zoom
  // factor :: Zoom factor, so 0.5 = cuts timespan in half, 2 doubles timespan
  $scope.zoom = function(factor) {
    var _now = Date.now();
    var _range = filterSrv.timeRange('min');
    var _timespan = (_range.to.valueOf() - _range.from.valueOf());
    var _center = _range.to.valueOf() - _timespan/2;

    var _to = (_center + (_timespan*factor)/2);
    var _from = (_center - (_timespan*factor)/2);

    // If we're not already looking into the future, don't.
    if(_to > Date.now() && _range.to < Date.now()) {
      var _offset = _to - Date.now();
      _from = _from - _offset;
      _to = Date.now();
    }

    if(factor > 1) {
      filterSrv.removeByType('time');
    }
    filterSrv.set({
      type:'time',
      from:moment.utc(_from),
      to:moment.utc(_to),
      field:$scope.panel.time_field
    });

    dashboard.refresh();
  };

  // I really don't like this function, too much dom manip. Break out into directive?
  $scope.populate_modal = function(request) {
    $scope.modal = {
      title: "Inspector",
      body : "<h5>Last Elasticsearch Query</h5><pre>"+
          'curl -XGET '+config.elasticsearch+'/'+dashboard.indices+"/_search?pretty -d'\n"+
          angular.toJson(JSON.parse(request.toString()),true)+
        "'</pre>",
    };
  };

  $scope.set_refresh = function (state) {
    $scope.refresh = state;
  };

  $scope.close_edit = function() {
    if($scope.refresh) {
      $scope.get_data();
    }
    $scope.refresh =  false;
    $scope.$emit('render');
  };

  $scope.add_series = function () {

    var new_series = {
      value_field: null,
      hide: false
    };
    $scope.panel.series.push(new_series);
    $scope.refresh =  true;
  };

})
.directive('rawgraphChart', function(dashboard, eventBus, filterSrv, $rootScope) {
  return {
    restrict: 'A',
    template: '<div></div>',
    link: function(scope, elem, attrs, ctrl) {

      // Receive render events
      scope.$on('render',function(){
        render_panel();
      });

      // Re-render if the window is resized
      angular.element(window).bind('resize', function(){
        render_panel();
      });

      // Function for rendering panel
      function render_panel() {

        // IE doesn't work without this
        elem.css({height:scope.panel.height||scope.row.height});

        if (scope.plotseries.length === 0) {
            elem.text("No series to draw for the moment");
            return;
        }

        // Populate from the query service
        try {
          _.each(scope.plotseries,function(series) {
            series.label = series.info.alias;
            series.color = series.info.color;
          });
        } catch(e) {
            elem.text("Something is wrong about alias series or color series");
            return;
        }

        var scripts = $LAB.script("common/lib/panels/jquery.flot.js").wait()
          .script("common/lib/panels/jquery.flot.time.js")
          .script("common/lib/panels/jquery.flot.stack.js")
          .script("common/lib/panels/jquery.flot.selection.js")
          .script("common/lib/panels/timezone.js");

        // Populate element. Note that jvectormap appends, does not replace.
        scripts.wait(function(){
          var stack = scope.panel.stack ? true : null;

          // Populate element
          try {
            var options = {
              legend: { show: false },
              series: {
                stackpercent: scope.panel.stack ? scope.panel.percentage : false,
                stack: scope.panel.percentage ? null : stack,
                lines:  {
                  show: scope.panel.lines,
                  fill: scope.panel.fill/10,
                  lineWidth: scope.panel.linewidth,
                  steps: false
                },
                bars:   { show: scope.panel.bars,  fill: 1, barWidth: 1 },
                points: { show: scope.panel.points, fill: 1, fillColor: false, radius: 5},
                shadowSize: 1
              },
              yaxis: {
                show: scope.panel['y-axis'],
                min: 0,
                max: scope.panel.percentage && scope.panel.stack ? 100 : null,
                color: "#c8c8c8"
              },
              xaxis: {
                timezone: scope.panel.timezone,
                show: scope.panel['x-axis'],
                mode: "time",
                timeformat: "%H:%M:%S",
                label: "Datetime",
                color: "#c8c8c8",
              },
              grid: {
                backgroundColor: null,
                borderWidth: 0,
                borderColor: '#eee',
                color: "#fff",
                hoverable: true,
              },
              colors: ['#86B22D','#BF6730','#1D7373','#BFB930','#BF3030','#77207D']
            };

            if(scope.panel.interactive) {
              options.selection = { mode: "x", color: '#aaa' };
            }

            scope.plot = $.plot(elem, scope.plotseries, options);

            // Work around for missing legend at initialization.
            if(!scope.$$phase) {
              scope.$apply();
            }

          } catch(e) {
            elem.text(e);
          }
        });
      }

      function tt(x, y, contents) {
        // If the tool tip already exists, don't recreate it, just update it
        var tooltip = $('#pie-tooltip').length ?
          $('#pie-tooltip') : $('<div id="pie-tooltip"></div>');

        tooltip.html(contents).css({
          position: 'absolute',
          top     : y + 5,
          left    : x + 5,
          color   : "#c8c8c8",
          padding : '10px',
          'font-size': '11pt',
          'font-weight' : 200,
          'background-color': '#1f1f1f',
          'border-radius': '5px',
        }).appendTo("body");
      }

      elem.bind("plothover", function (event, pos, item) {
        if (item) {
          tt(pos.pageX, pos.pageY,
            "<div style='vertical-align:middle;display:inline-block;background:"+
            item.series.color+";height:15px;width:15px;border-radius:10px;'></div> "+
            item.datapoint[1].toFixed(0) + " @ " +
            moment(item.datapoint[0]).format('MM/DD HH:mm:ss'));
        } else {
          $("#pie-tooltip").remove();
        }
      });

      elem.bind("plotselected", function (event, ranges) {
        var _id = filterSrv.set({
          type  : 'time',
          from  : moment.utc(ranges.xaxis.from),
          to    : moment.utc(ranges.xaxis.to),
          field : scope.panel.time_field
        });
        dashboard.refresh();
      });
    }
  };
});
